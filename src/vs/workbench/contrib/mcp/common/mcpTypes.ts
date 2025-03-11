/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assertNever } from '../../../../base/common/assert.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { equals as objectsEqual } from '../../../../base/common/objects.js';
import { IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceFolderData } from '../../../../platform/workspace/common/workspace.js';
import { McpServerRequestHandler } from './mcpServerRequestHandler.js';
import { MCP } from './modelContextProtocol.js';

/**
 * An McpCollection contains McpServers. There may be multiple collections for
 * different locations servers are discovered.
 */
export interface McpCollectionDefinition {
	/** Origin authority from which this collection was discovered. */
	readonly remoteAuthority: string | null;
	/** Globally-unique, stable ID for this definition */
	readonly id: string;
	/** Human-readable label for the definition */
	readonly label: string;
	/** Definitions this collection contains. */
	readonly serverDefinitions: IObservable<readonly McpServerDefinition[]>;
	/** If 'false', consent is required before any MCP servers in this collection are automatically launched. */
	readonly isTrustedByDefault: boolean;
	/** Scope where associated collection info should be stored. */
	readonly scope: StorageScope;
	/** Sort order of the collection. */
	readonly order?: number;
}

export const enum McpCollectionSortOrder {
	Workspace = 0,
	User = 100,
	Filesystem = 200,

	RemotePenalty = 50,
}

export namespace McpCollectionDefinition {
	export interface FromExtHost {
		readonly id: string;
		readonly label: string;
		readonly isTrustedByDefault: boolean;
		readonly scope: StorageScope;
	}

	export function equals(a: McpCollectionDefinition, b: McpCollectionDefinition): boolean {
		return a.id === b.id
			&& a.remoteAuthority === b.remoteAuthority
			&& a.label === b.label
			&& a.isTrustedByDefault === b.isTrustedByDefault;
	}
}

export interface McpServerDefinition {
	/** Globally-unique, stable ID for this definition */
	readonly id: string;
	/** Human-readable label for the definition */
	readonly label: string;
	/** Descriptor defining how the configuration should be launched. */
	readonly launch: McpServerLaunch;
	/** If set, allows configuration variables to be resolved in the {@link launch} with the given context */
	readonly variableReplacement?: {
		section?: string; // e.g. 'mcp'
		folder?: IWorkspaceFolderData;
		target?: ConfigurationTarget;
	};
}

export namespace McpServerDefinition {
	export function equals(a: McpServerDefinition, b: McpServerDefinition): boolean {
		return a.id === b.id
			&& a.label === b.label
			&& objectsEqual(a.launch, b.launch)
			&& objectsEqual(a.variableReplacement, b.variableReplacement);
	}
}

export interface IMcpService {
	_serviceBrand: undefined;
	readonly servers: IObservable<readonly IMcpServer[]>;
}

export const IMcpService = createDecorator<IMcpService>('IMcpService');

export interface IMcpServer extends IDisposable {
	readonly collection: McpCollectionDefinition;
	readonly definition: McpServerDefinition;
	readonly state: IObservable<McpConnectionState>;
	showOutput(): void;
	start(): Promise<McpConnectionState>;
	stop(): Promise<void>;

	readonly tools: IObservable<readonly IMcpTool[]>;
}


export interface IMcpTool {

	readonly id: string;

	readonly definition: MCP.Tool;
	/**
	 * Calls a tool
	 * @throws {@link MpcResponseError} if the tool fails to execute
	 * @throws {@link McpConnectionFailedError} if the connection to the server fails
	 */
	call(params: Record<string, unknown>, token?: CancellationToken): Promise<MCP.CallToolResult>;
}

export const enum McpServerTransportType {
	/** A command-line MCP server communicating over standard in/out */
	Stdio = 1 << 0,
	/** An MCP server that uses Server-Sent Events */
	SSE = 1 << 1,
}

/**
 * MCP server launched on the command line which communicated over stdio.
 * https://spec.modelcontextprotocol.io/specification/2024-11-05/basic/transports/#stdio
 */
export interface McpServerTransportStdio {
	readonly type: McpServerTransportType.Stdio;
	readonly cwd: URI | undefined;
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Record<string, string | number | null>;
}

/**
 * MCP server launched on the command line which communicated over server-sent-events.
 * https://spec.modelcontextprotocol.io/specification/2024-11-05/basic/transports/#http-with-sse
 */
export interface McpServerTransportSSE {
	readonly type: McpServerTransportType.SSE;
	readonly url: string;
}

export type McpServerLaunch =
	| McpServerTransportStdio
	| McpServerTransportSSE;

/**
 * An instance that manages a connection to an MCP server. It can be started,
 * stopped, and restarted. Once started and in a running state, it will
 * eventually build a {@link IMcpServerConnection.handler}.
 */
export interface IMcpServerConnection extends IDisposable {
	readonly definition: McpServerDefinition;
	readonly state: IObservable<McpConnectionState>;
	readonly handler: IObservable<McpServerRequestHandler | undefined>;

	/**
	 * Shows the current server output.
	 */
	showOutput(): void;

	/**
	 * Starts the server if it's stopped. Returns a promise that resolves once
	 * server exits a 'starting' state.
	 */
	start(): Promise<McpConnectionState>;

	/**
	 * Stops the server.
	 */
	stop(): Promise<void>;
}

/**
 * McpConnectionState is the state of the underlying connection and is
 * communicated e.g. from the extension host to the renderer.
 */
export namespace McpConnectionState {
	export const enum Kind {
		Stopped,
		Starting,
		Running,
		Error,
	}

	export const toString = (s: McpConnectionState): string => {
		switch (s.state) {
			case Kind.Stopped:
				return localize('mcpstate.stopped', 'Stopped');
			case Kind.Starting:
				return localize('mcpstate.starting', 'Starting');
			case Kind.Running:
				return localize('mcpstate.running', 'Running');
			case Kind.Error:
				return localize('mcpstate.error', 'Error {0}', s.message);
			default:
				assertNever(s);
		}
	};

	/** Returns if the MCP state is one where starting a new server is valid */
	export const canBeStarted = (s: Kind) => s === Kind.Error || s === Kind.Stopped;

	export interface Stopped {
		readonly state: Kind.Stopped;
	}

	export interface Starting {
		readonly state: Kind.Starting;
	}

	export interface Running {
		readonly state: Kind.Running;
	}

	export interface Error {
		readonly state: Kind.Error;
		readonly message: string;
	}
}

export type McpConnectionState =
	| McpConnectionState.Stopped
	| McpConnectionState.Starting
	| McpConnectionState.Running
	| McpConnectionState.Error;

export class MpcResponseError extends Error {
	constructor(message: string, public readonly code: number, public readonly data: unknown) {
		super(`MPC ${code}: ${message}`);
	}
}

export class McpConnectionFailedError extends Error { }
