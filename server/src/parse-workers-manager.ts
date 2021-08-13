import { CancellationTokenSource, DocumentSymbol,Range } from 'vscode-languageserver/node';
import { preprocessAllFiles } from './parser/preprocessor';
import { statSync, readFileSync, writeSync, writeFileSync, exists, existsSync } from 'fs';
import { URI, Utils } from 'vscode-uri';
import { spawn, Pool, Worker, Thread } from 'threads';
import { abortParsingProcess, preprocessedFilesCacheMap, connection, symbolManager, documents } from './server';
import { clearCompletionCache } from './modules/completions';
import { basename, dirname } from 'path';
import { identity } from 'underscore';
import { Tads3SymbolManager } from './modules/symbol-manager';
import * as path from 'path';
import { start } from 'repl';
import { ensureDirSync } from 'fs-extra';


/**
 * Reads and parses the makefile to get additional information
 * such as which library it uses, paths, flags etc..
 * @param chosenMakefileUri 
 */
 function analyzeMakefile(chosenMakefileUri: string) {
	const makefileString = readFileSync(chosenMakefileUri).toString();
	const makeFileArray = makefileString.split(/\r?\n/);
	const makefileArray = [];
	for(const row of makeFileArray) {
		if(row.trimLeft().startsWith('#')) {
			continue;
		}
		const [key,value]= row.replace('  ',' ').split(' ');
		if(key && value) {
			makefileArray.push({key,value});
		}
	}
	/*makefileArray.forEach((keyvalue,index)=> {
		//

	});*/

	connection.console.log(`Done analyzing makefile`);
	return makefileArray;
}

let lastMakeFileLocation: string|undefined;
let makefileStructure;
let usingAdv3Lite = false;

export function isUsingAdv3Lite(): boolean {
	return usingAdv3Lite;
}

let initialParsing = true;
let globalStorageCachePath: string|undefined;


const adv3LitePathRegExp = RegExp(/[/]?adv3[Ll]ite[/]/);

const adv3PathRegExp = RegExp(/[/]?adv3[/]/);

const generalHeaderIncludeRegExp  = RegExp(/tads3[/]include[/]/);

/**
 * 
 * @param makefileLocation string holding the file location of the makefile
 * @param filePaths string array of files to parse, "undefined" means parse all files
 * @param token CancellationToken
 */
export async function preprocessAndParseFiles(globalStoragePath: string, makefileLocation: string, filePaths: string[]|undefined, token: any) {

	if(lastMakeFileLocation !== makefileLocation) {
		lastMakeFileLocation = makefileLocation;
		makefileStructure = analyzeMakefile(makefileLocation);
		usingAdv3Lite = !!makefileStructure?.find(keyvalue => keyvalue.value.match(adv3LitePathRegExp)) ?? false;
		connection.console.log('Project using ' + usingAdv3Lite?'adv3Lite':'standard adv3 library');
		connection.sendNotification('response/makefile/keyvaluemap', {makefileStructure, usingAdv3Lite});
	} 

	if(globalStoragePath) {
		ensureDirSync(globalStoragePath);
		connection.console.log(`Ensuring "${globalStoragePath}" exists`);
		ensureDirSync(path.join(globalStoragePath,'.cache'));
		const library = usingAdv3Lite?'adv3Lite':'adv3';
		globalStorageCachePath = path.join(globalStoragePath,'.cache', library );

		connection.console.log(`Ensuring "${globalStorageCachePath}" exists`);
		ensureDirSync(globalStorageCachePath);
		//const p = path.join(globalStorageCachePath,'test');
		//writeFileSync(p, 'some contents');
	}


	await preprocessAllFiles(makefileLocation, preprocessedFilesCacheMap);
	connection.sendNotification('response/preprocessed/list', [...preprocessedFilesCacheMap.keys()]);

	let allFilePaths = filePaths;

	// Parse project files close to the makefile first:
	const baseDir = Utils.dirname(URI.parse(makefileLocation)).fsPath;

	if (filePaths === undefined) {
		allFilePaths = [...preprocessedFilesCacheMap.keys()];

		// Sort by size, size ordering, the largest files goes first:
		allFilePaths = allFilePaths.sort((a: string, b: string) => statSync(b).size - statSync(a).size);

		// Then sort out all files in the project directory first:
		allFilePaths = allFilePaths.sort((a: string, b: string) => {
			if (a.startsWith(baseDir)) {
				return -1;
			}
			return 0;
		});
	}
	if (allFilePaths === undefined) {
		console.error(`No files found to parse`);
		connection.sendNotification('symbolparsing/allfiles/failed', allFilePaths);
		return;
	}
    connection.console.log(`Preparing to parse a total of ${allFilePaths.length} files`);

    const maxNumberOfParseWorkerThreads:number = await connection.workspace.getConfiguration("tads3.maxNumberOfParseWorkerThreads");

	const parseOnlyTheWorkspaceFiles:boolean = await connection.workspace.getConfiguration("tads3.parseOnlyTheWorkspaceFiles");
	if(parseOnlyTheWorkspaceFiles) {
		allFilePaths = allFilePaths.filter(x=>x.startsWith(baseDir));
		connection.console.log(`Only parses files with base directory: ${baseDir}`); // Default 6 threads
		connection.console.log(`****\n${allFilePaths.map(x=>basename(x)).join('\n')}****\n`);
	}
	if (allFilePaths.length === 0) {
		connection.console.log(`No files to parse. Aborting operation`);
		return;
	}


	// Temporary, just the first files to speed up
	//allFilePaths = allFilePaths.splice(0,14);
	const totalFiles = allFilePaths?.length;
	let tracker = 0;


	
	// TODO: spawning a single worker instead of a thread pool
	/*if(allFilePaths.length === 1) {
		// Spawn a single worker if only one file is to be parsed
		const filePath = allFilePaths[0];
		const startTime = Date.now();
		connection.console.log(`Parsing single file: ${filePath}`);
		const worker = await spawn(new Worker('./worker'));
		const text = preprocessedFilesCacheMap.get(filePath) ?? '';
		const jobResult = await worker['parseFunc'](filePath, text);

		await Thread.terminate(jobResult);
		const { symbols, keywords, additionalProperties} = jobResult;
		
		symbolManager.symbols.set(filePath, symbols ?? []);
		symbolManager.keywords.set(filePath, keywords ?? []);
		clearCompletionCache();
		symbolManager.additionalProperties.set(filePath, additionalProperties);
		tracker++;
		const elapsedTime = Date.now() - startTime;
		console.log(`All files parsed within ${elapsedTime} ms`);
		connection.sendNotification('symbolparsing/success', [filePath, tracker, totalFiles, 1]);
		connection.console.log(`${filePath} parsed successfully`);
	} else {
		*/

		// Setup a WorkerPool if we have a collection of files to parse

		const poolSize = allFilePaths.length >= maxNumberOfParseWorkerThreads ? maxNumberOfParseWorkerThreads : 1;
		connection.console.log(`Setting worker thread poolsize to: ${poolSize}`); // Default 6 threads
			
		const workerPool = Pool(() => spawn(new Worker('./worker')), poolSize);
	
		try {
			const startTime = Date.now();
			let cachedFiles = new Set();
			if(initialParsing) {
				cachedFiles = importLibrarySymbols(symbolManager.symbols, usingAdv3Lite);
				importLibraryKeywords(symbolManager.keywords, usingAdv3Lite);
				const elapsedCacheReadTime = Date.now() - startTime;
				connection.console.log(`Cached library files took ${elapsedCacheReadTime} ms to read`);
			}
	
			for (const filePath of allFilePaths) {
				connection.console.log(`Queuing parsing job ${filePath}`);
	
				// Only use cached values 
				if(!cachedFiles.has(filePath)) {
					workerPool.queue(async (parseJob) => {
	
						//TODO consider report file before processing it: 
						// e.g connection.sendNotification('symbolparsing/processing', [filePath, tracker, totalFiles, poolSize]);
						const text = preprocessedFilesCacheMap.get(filePath) ?? '';
						const { symbols, keywords, additionalProperties} = await parseJob(filePath, text);
	
						symbolManager.symbols.set(filePath, symbols ?? []);
						symbolManager.keywords.set(filePath, keywords ?? []);
	
						clearCompletionCache();
						symbolManager.additionalProperties.set(filePath, additionalProperties);
						tracker++;
						connection.sendNotification('symbolparsing/success', [filePath, tracker, totalFiles, poolSize]);
						connection.console.log(`${filePath} parsed successfully`);
					});
				} else {
					tracker++;
					connection.sendNotification('symbolparsing/success', [filePath, tracker, totalFiles, poolSize]);
					connection.console.log(`${filePath} cached restored successfully`);
				}
	
	
			}
	
			try {
				//workerPool.events.length
				await workerPool.completed();
				await workerPool.terminate();
			} catch(err) {
				connection.console.error(`Error happened during awaiting pool completion/termination: `+ err);
			}
	
			


			const elapsedTime = Date.now() - startTime;
			console.log(`All files parsed within ${elapsedTime} ms`);
			connection.sendNotification('symbolparsing/allfiles/success', { allFilePaths, elapsedTime });
	
			if(initialParsing) {
				const startTime = Date.now();
				exportLibrarySymbols(symbolManager.symbols, usingAdv3Lite);
				exportLibraryKeywords(symbolManager.keywords, usingAdv3Lite);
				const elapsedCacheReadTime = Date.now() - startTime;
				connection.console.log(`Cached library files export took ${elapsedCacheReadTime} ms to write`);
			}
			initialParsing = false;
			
		} catch (err) {
			await workerPool.terminate();
			connection.console.error(`Error happened during parsing of files: ${err}`);
			connection.sendNotification('symbolparsing/allfiles/failed', allFilePaths);
		}
	//}
}

function exportLibrarySymbols(symbols: Map<string, DocumentSymbol[]>, usingAdv3Lite: boolean) {
	const librarySymbolsFilePaths = filterForLibraryFiles([...preprocessedFilesCacheMap.keys()]);
	const librarySymbols = new Map();
	for(const file of librarySymbolsFilePaths) {
		librarySymbols.set(file, symbols.get(file));
	}
	for (const libraryPath of librarySymbols.keys()) {
		const value = librarySymbols.get(libraryPath);
		const fileNameStr = `${basename(libraryPath)}__symbols.json`;
		if (globalStorageCachePath) {
			const libraryCacheFilePath = path.join(globalStorageCachePath, fileNameStr).toString();
			try {
				writeFileSync(libraryCacheFilePath, JSON.stringify(value).toString());
				connection.console.log(`Cached symbols exported for ${libraryPath} to ${libraryCacheFilePath}`);
			} catch (err) {
				connection.console.error(`Caching failed for ${libraryPath}: \n` + err);
			}
		}
	}
}

function exportLibraryKeywords(keywords: Map<string, Map<string, Range[]>>,usingAdv3Lite: boolean) {
	const libraryKeywordsFilePaths = filterForLibraryFiles([...preprocessedFilesCacheMap.keys()]);
	const libraryKeywords = new Map();
	for(const file of libraryKeywordsFilePaths) {
		libraryKeywords.set(file, keywords.get(file));
	}
	if(globalStorageCachePath) {
		for(const libraryKeywordPath of libraryKeywords.keys()) {
			const keywordRangeMap = libraryKeywords.get(libraryKeywordPath);
			if(keywordRangeMap) {
				const keywordRangeMapArray = [...keywordRangeMap];
				try {
					const fileNameStr = `${basename(libraryKeywordPath)}__keywords.json`;
					const libraryCacheFilePath = path.join(globalStorageCachePath, fileNameStr).toString();					
					writeFileSync(libraryCacheFilePath, JSON.stringify(keywordRangeMapArray).toString());
					connection.console.log(`Cached keywords exported for${libraryKeywordPath} to ${libraryCacheFilePath}`);
				} catch(err) {
					connection.console.error(`Error happened during export of keywords: ${err}`);
				}
			}
		}
	}
}

function importLibrarySymbols(symbolManagerSymbols: Map<string, DocumentSymbol[]>, usingAdv3Lite: boolean) {
	const librarySymbolsFilePaths = filterForLibraryFiles([...preprocessedFilesCacheMap.keys()]);
	const cachedFiles = new Set();
	if(globalStorageCachePath) {
		for(const librarySymbolPath of librarySymbolsFilePaths) {
			if(!existsSync(librarySymbolPath)) { continue;}
			try {
				const fileNameStr = `${basename(librarySymbolPath)}__symbols.json`;
				const libraryCacheFilePath = path.join(globalStorageCachePath,fileNameStr).toString();
				const data = readFileSync(libraryCacheFilePath).toString();
				const symbols:DocumentSymbol[] = JSON.parse(data);
				symbolManagerSymbols.set(librarySymbolPath, symbols);
				connection.console.log('Cached symbols filed used for' + librarySymbolPath);
				cachedFiles.add(librarySymbolPath);
			} catch (err) {
				connection.console.error(`Error happened during import of symbols: ${err}`);
			}
		}
	}
	return cachedFiles;
}


function filterForLibraryFiles(array: string[]) {
	return array.filter((x:string)=>{
		return x.match(usingAdv3Lite ? adv3LitePathRegExp : adv3PathRegExp) 
			|| x.match(generalHeaderIncludeRegExp);
	});
}

/**
 * TODO: make sure this works... 
 * @param symbolManagerKeywords 
 * @param usingAdv3Lite 
 */
function importLibraryKeywords(symbolManagerKeywords: Map<string, Map<string, Range[]>>, usingAdv3Lite: boolean) {
	const libraryKeywordsFilePaths = filterForLibraryFiles([...preprocessedFilesCacheMap.keys()]);
	const cachedFiles = new Set();
	if(globalStorageCachePath) {
		for(const libraryKeywordPath of libraryKeywordsFilePaths) {
			const fileNameStr = `${basename(libraryKeywordPath)}__keywords.json`;
			const libraryCacheFilePath = path.join(globalStorageCachePath, fileNameStr).toString();
			if(existsSync(libraryCacheFilePath)) {
				if(!existsSync(libraryCacheFilePath)) { continue;}
				const data = readFileSync(libraryCacheFilePath).toString();
				const keywords:any = new Map(JSON.parse(data));
				symbolManagerKeywords.set(libraryKeywordPath, keywords);		
				connection.console.log('Cached symbols filed used for' + libraryKeywordPath);
				cachedFiles.add(libraryCacheFilePath);
			}
		}
	}
	return cachedFiles;
}
