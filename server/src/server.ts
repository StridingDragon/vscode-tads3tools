/* eslint-disable @typescript-eslint/no-empty-function */
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	TextDocumentSyncKind,
	InitializeResult,
	Range,
	CancellationTokenSource,
	CodeLensRequest,
	CodeLensResolveRequest,
	SymbolKind} from 'vscode-languageserver/node';



import { Tads3SymbolManager } from './modules/symbol-manager';
import { onDocumentSymbol } from './modules/symbols';
import { onReferences } from './modules/references';
import { onDefinition } from './modules/definitions';
import { preprocessAndParseFiles } from './parse-workers-manager';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DefaultMapObject } from './modules/mapcrawling/DefaultMapObject';
import MapObjectManager from './modules/mapcrawling/map-mapping';
import { onCodeLens } from './modules/codelens';



export const preprocessedFilesCacheMap = new Map<string, string>();
export const symbolManager = new Tads3SymbolManager();
export const mapper = new MapObjectManager(symbolManager);

export default function processMapSymbols(symbolManager: Tads3SymbolManager, callback: any) {
	const symbols = mapper.mapGameObjectsToMapObjects();
	callback(symbols);
}

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
export const connection = createConnection(ProposedFeatures.all);

/*export function getCurrentDocument() {
	return currentDocument;
}*/

// Create a simple text document manager.
export const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			documentSymbolProvider: true,
			referencesProvider: false, // TODO: need to fix the row synchronization issue
			definitionProvider: true,
			codeLensProvider: {
				resolveProvider: true,
			},
			textDocumentSync: {
				openClose: true,
				change: TextDocumentSyncKind.Full,
			},
			// Tell the client that this server supports code completion.
			/*completionProvider: {
				resolveProvider: true
			}*/
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

export let abortParsingProcess: CancellationTokenSource| undefined;

connection.onInitialized(() => {
	
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}

	connection.onNotification('symbolparsing/abort', ()=> {
		abortParsingProcess?.cancel();
	});

	connection.onNotification('request/mapsymbols', () => {
		processMapSymbols(symbolManager, (symbols: DefaultMapObject[]) => {
			// TODO: doesn't show up in the client
			connection.sendNotification('response/mapsymbols', symbols);
		});
	});

	// In case the client asks for a symbol, locate it and send it back
	connection.onRequest('request/findsymbol', ({ name }) => {
		const symbol = symbolManager.findSymbol(name);
		if (symbol) {
			connection.console.log(`Found symbol: ${name}`);
			connection.sendNotification('response/foundsymbol', symbolManager.findSymbol(name));
		}
	});


});

// The tads3 global settings
interface Tads3Settings {
	maxNumberOfProblems: number;
	enablePreprocessorCodeLens: boolean;
	include: string;
	lib: string;
} 

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: Tads3Settings = { 
	maxNumberOfProblems: 1000, 
	enablePreprocessorCodeLens: false, 
	include: "/usr/local/share/frobtads/tads3/include/",
	lib: "/usr/local/share/frobtads/tads3/lib/",
};

let globalSettings: Tads3Settings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<Tads3Settings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		documentSettings.clear();		// Reset all cached document settings
	} else {
		globalSettings = <Tads3Settings>((change.settings.tads3 || defaultSettings));
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);


});

/*
function getDocumentSettings(resource: string): Thenable<Tads3Settings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'tads3'
		});
		documentSettings.set(resource, result);
	}
	return result;
}*/

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(async params => {
	validateTextDocument(params.document);

});


async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	const diagnostics: Diagnostic[] = [];
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}


connection.onDidChangeWatchedFiles(_change => {
	connection.console.log('We received an file change event');
});

connection.onDocumentSymbol(async (handler) => onDocumentSymbol(handler, documents, symbolManager));
connection.onReferences(async (handler) => onReferences(handler,documents, symbolManager));
connection.onDefinition(async (handler) => onDefinition(handler,documents, symbolManager));

connection.onCodeLens(async (handler) => {
	return onCodeLens(handler, documents, symbolManager);
});


connection.onRequest('request/preprocessed/file', async (params) => {
	const { path, range } = params;
	const text = preprocessedFilesCacheMap.get(path);
	connection.sendNotification('response/preprocessed/file', { path, text } );
});


connection.onRequest('request/analyzeText/findNouns', async (params) => {
	const { path, position } = params;
	
	// TODO: get the position instead and use the preprocessed text 
	const preprocessedText = preprocessedFilesCacheMap.get(path);
	const array = preprocessedText?.split(/\r?\n/) ?? [];
	const line = array[position.line];
	connection.console.log(`Analyzing: ${line}`);
	const tree = analyzeText(line);

	// TODO: Calculate where to best put the suggestions
	const { symbol } = symbolManager.findClosestSymbolKindByPosition(SymbolKind.Object, position);
	connection.console.log(`Closest object symbol: ${symbol.name}, therefore range ${symbol.range}`);

	connection.sendNotification('response/analyzeText/findNouns', { tree: tree, range: symbol.range } );
});

connection.onRequest('executeParse', async ({ makefileLocation, filePaths, token }) => {
	await preprocessAndParseFiles(makefileLocation, filePaths, token); 
});


// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

connection.listen();


// eslint-disable-next-line @typescript-eslint/no-var-requires
const posTagger = require('wink-pos-tagger');

function analyzeText(text: string) {
	const tagger = posTagger();
	const tagged = tagger.tagSentence(text);
	const nnTagged = tagged.filter((x:any) => x.pos === 'NN');
	return nnTagged;
}
