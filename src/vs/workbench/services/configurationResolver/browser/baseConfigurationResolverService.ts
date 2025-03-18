/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Queue } from '../../../../base/common/async.js';
import { IStringDictionary } from '../../../../base/common/collections.js';
import { LRUCache } from '../../../../base/common/map.js';
import { Schemas } from '../../../../base/common/network.js';
import { IProcessEnvironment } from '../../../../base/common/platform.js';
import * as Types from '../../../../base/common/types.js';
import { URI as uri } from '../../../../base/common/uri.js';
import { ICodeEditor, isCodeEditor, isDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationOverrides, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IInputOptions, IPickOptions, IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, IWorkspaceFolderData, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../editor/common/editorService.js';
import { IExtensionService } from '../../extensions/common/extensions.js';
import { IPathService } from '../../path/common/pathService.js';
import { ConfiguredInput, VariableError, VariableKind } from '../common/configurationResolver.js';
import { AbstractVariableResolverService } from '../common/variableResolver.js';
import { ConfigurationResolverExpression } from '../common/configurationResolverExpression.js';

const LAST_INPUT_STORAGE_KEY = 'configResolveInputLru';
const LAST_INPUT_CACHE_SIZE = 5;

export abstract class BaseConfigurationResolverService extends AbstractVariableResolverService {

	static readonly INPUT_OR_COMMAND_VARIABLES_PATTERN = /\${((input|command):(.*?))}/g;

	private userInputAccessQueue = new Queue<string | IQuickPickItem | undefined>();

	constructor(
		context: {
			getAppRoot: () => string | undefined;
			getExecPath: () => string | undefined;
		},
		envVariablesPromise: Promise<IProcessEnvironment>,
		editorService: IEditorService,
		private readonly configurationService: IConfigurationService,
		private readonly commandService: ICommandService,
		private readonly workspaceContextService: IWorkspaceContextService,
		private readonly quickInputService: IQuickInputService,
		private readonly labelService: ILabelService,
		private readonly pathService: IPathService,
		extensionService: IExtensionService,
		private readonly storageService: IStorageService,
	) {
		super({
			getFolderUri: (folderName: string): uri | undefined => {
				const folder = workspaceContextService.getWorkspace().folders.filter(f => f.name === folderName).pop();
				return folder ? folder.uri : undefined;
			},
			getWorkspaceFolderCount: (): number => {
				return workspaceContextService.getWorkspace().folders.length;
			},
			getConfigurationValue: (folderUri: uri | undefined, section: string): string | undefined => {
				return configurationService.getValue<string>(section, folderUri ? { resource: folderUri } : {});
			},
			getAppRoot: (): string | undefined => {
				return context.getAppRoot();
			},
			getExecPath: (): string | undefined => {
				return context.getExecPath();
			},
			getFilePath: (): string | undefined => {
				const fileResource = EditorResourceAccessor.getOriginalUri(editorService.activeEditor, {
					supportSideBySide: SideBySideEditor.PRIMARY,
					filterByScheme: [Schemas.file, Schemas.vscodeUserData, this.pathService.defaultUriScheme]
				});
				if (!fileResource) {
					return undefined;
				}
				return this.labelService.getUriLabel(fileResource, { noPrefix: true });
			},
			getWorkspaceFolderPathForFile: (): string | undefined => {
				const fileResource = EditorResourceAccessor.getOriginalUri(editorService.activeEditor, {
					supportSideBySide: SideBySideEditor.PRIMARY,
					filterByScheme: [Schemas.file, Schemas.vscodeUserData, this.pathService.defaultUriScheme]
				});
				if (!fileResource) {
					return undefined;
				}
				const wsFolder = workspaceContextService.getWorkspaceFolder(fileResource);
				if (!wsFolder) {
					return undefined;
				}
				return this.labelService.getUriLabel(wsFolder.uri, { noPrefix: true });
			},
			getSelectedText: (): string | undefined => {
				const activeTextEditorControl = editorService.activeTextEditorControl;

				let activeControl: ICodeEditor | null = null;

				if (isCodeEditor(activeTextEditorControl)) {
					activeControl = activeTextEditorControl;
				} else if (isDiffEditor(activeTextEditorControl)) {
					const original = activeTextEditorControl.getOriginalEditor();
					const modified = activeTextEditorControl.getModifiedEditor();
					activeControl = original.hasWidgetFocus() ? original : modified;
				}

				const activeModel = activeControl?.getModel();
				const activeSelection = activeControl?.getSelection();
				if (activeModel && activeSelection) {
					return activeModel.getValueInRange(activeSelection);
				}
				return undefined;
			},
			getLineNumber: (): string | undefined => {
				const activeTextEditorControl = editorService.activeTextEditorControl;
				if (isCodeEditor(activeTextEditorControl)) {
					const selection = activeTextEditorControl.getSelection();
					if (selection) {
						const lineNumber = selection.positionLineNumber;
						return String(lineNumber);
					}
				}
				return undefined;
			},
			getColumnNumber: (): string | undefined => {
				const activeTextEditorControl = editorService.activeTextEditorControl;
				if (isCodeEditor(activeTextEditorControl)) {
					const selection = activeTextEditorControl.getSelection();
					if (selection) {
						const columnNumber = selection.positionColumn;
						return String(columnNumber);
					}
				}
				return undefined;
			},
			getExtension: id => {
				return extensionService.getExtension(id);
			},
		}, labelService, pathService.userHome().then(home => home.path), envVariablesPromise);
	}

	override async resolveWithInteractionReplace(folder: IWorkspaceFolderData | undefined, config: any, section?: string, variables?: IStringDictionary<string>, target?: ConfigurationTarget): Promise<any> {
		// First resolve any non-interactive variables and any contributed variables
		config = await this.resolveAnyAsync(folder, config);

		// Then resolve input variables in the order in which they are encountered
		const resolvedVariables = await this.resolveWithInteraction(folder, config, section, variables, target);
		if (!resolvedVariables) {
			return null;
		}

		// Finally resolve any remaining variables and apply the resolved input/command variables
		if (resolvedVariables.size > 0) {
			return this.resolveAnyAsync(folder, config, Object.fromEntries(resolvedVariables));
		}

		return config;
	}

	override async resolveWithInteraction(folder: IWorkspaceFolderData | undefined, config: any, section?: string, variableToCommandMap?: IStringDictionary<string>, target?: ConfigurationTarget): Promise<Map<string, string> | undefined> {
		const expr = ConfigurationResolverExpression.parse(config);
		const resolvedVariables = new Map<string, string>();

		// Get all variables and their order of appearance
		const variables: { name: string; type: string; arg?: string }[] = [];
		for (const replacement of expr.unresolved()) {
			if (replacement.name === 'input' || replacement.name === 'command') {
				variables.push({ name: replacement.name, type: replacement.name, arg: replacement.arg });
			}
		}

		// If there are no input or command variables, we don't need to go through the UI flow
		if (!variables.length) {
			return resolvedVariables;
		}

		// Get values for input variables from UI
		for (const variable of variables) {
			let result: string | undefined;

			// Command
			if (variable.type === 'command') {
				const commandId = (variableToCommandMap ? variableToCommandMap[variable.arg!] : undefined) || variable.arg!;
				result = await this.commandService.executeCommand(commandId, config);
				if (typeof result !== 'string' && !Types.isUndefinedOrNull(result)) {
					throw new VariableError(VariableKind.Command, localize('commandVariable.noStringType', "Cannot substitute command variable '{0}' because command did not return a result of type string.", commandId));
				}
			}
			// Input
			else if (variable.type === 'input') {
				result = await this.showUserInput(section!, variable.arg!, await this.resolveInputs(folder, section!, target));
			}

			if (result === undefined) {
				// Skip the entire flow if any input variable was canceled
				return undefined;
			}

			resolvedVariables.set((variable.type === 'command' ? 'command:' : 'input:') + variable.arg!, result);
		}

		return resolvedVariables;
	}

	private async resolveInputs(folder: IWorkspaceFolderData | undefined, section: string, target?: ConfigurationTarget): Promise<ConfiguredInput[] | undefined> {
		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY || !section) {
			return undefined;
		}

		// Look at workspace configuration
		let inputs: ConfiguredInput[] | undefined;
		const overrides: IConfigurationOverrides = folder ? { resource: folder.uri } : {};
		const result = this.configurationService.inspect(section, overrides);

		if (result && (result.userValue || result.workspaceValue || result.workspaceFolderValue || result.userRemoteValue)) {
			switch (target) {
				case ConfigurationTarget.USER: inputs = (<any>result.userValue)?.inputs; break;
				case ConfigurationTarget.USER_REMOTE: inputs = (<any>result.userRemoteValue)?.inputs; break;
				case ConfigurationTarget.WORKSPACE: inputs = (<any>result.workspaceValue)?.inputs; break;
				default: inputs = (<any>result.workspaceFolderValue)?.inputs;
			}
		} else {
			const valueResult = this.configurationService.getValue<any>(section, overrides);
			if (valueResult) {
				inputs = valueResult.inputs;
			}
		}

		return inputs;
	}

	private readInputLru(): LRUCache<string, string> {
		const contents = this.storageService.get(LAST_INPUT_STORAGE_KEY, StorageScope.WORKSPACE);
		const lru = new LRUCache<string, string>(LAST_INPUT_CACHE_SIZE);
		try {
			if (contents) {
				lru.fromJSON(JSON.parse(contents));
			}
		} catch {
			// ignored
		}

		return lru;
	}

	private storeInputLru(lru: LRUCache<string, string>): void {
		this.storageService.store(LAST_INPUT_STORAGE_KEY, JSON.stringify(lru.toJSON()), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private async showUserInput(section: string, variable: string, inputInfos: ConfiguredInput[] | undefined): Promise<string | undefined> {
		if (!inputInfos) {
			throw new VariableError(VariableKind.Input, localize('inputVariable.noInputSection', "Variable '{0}' must be defined in an '{1}' section of the debug or task configuration.", variable, 'inputs'));
		}

		// Find info for the given input variable
		const info = inputInfos.filter(item => item.id === variable).pop();
		if (info) {
			const missingAttribute = (attrName: string) => {
				throw new VariableError(VariableKind.Input, localize('inputVariable.missingAttribute', "Input variable '{0}' is of type '{1}' and must include '{2}'.", variable, info.type, attrName));
			};

			const defaultValueMap = this.readInputLru();
			const defaultValueKey = `${section}.${variable}`;
			const previousPickedValue = defaultValueMap.get(defaultValueKey);

			switch (info.type) {
				case 'promptString': {
					if (!Types.isString(info.description)) {
						missingAttribute('description');
					}
					const inputOptions: IInputOptions = { prompt: info.description, ignoreFocusLost: true, value: previousPickedValue };
					if (info.default) {
						inputOptions.value = info.default;
					}
					if (info.password) {
						inputOptions.password = info.password;
					}
					return this.userInputAccessQueue.queue(() => this.quickInputService.input(inputOptions)).then(resolvedInput => {
						if (typeof resolvedInput === 'string') {
							this.storeInputLru(defaultValueMap.set(defaultValueKey, resolvedInput));
						}
						return resolvedInput as string;
					});
				}

				case 'pickString': {
					if (!Types.isString(info.description)) {
						missingAttribute('description');
					}
					if (Array.isArray(info.options)) {
						for (const pickOption of info.options) {
							if (!Types.isString(pickOption) && !Types.isString(pickOption.value)) {
								missingAttribute('value');
							}
						}
					} else {
						missingAttribute('options');
					}

					interface PickStringItem extends IQuickPickItem {
						value: string;
					}
					const picks = new Array<PickStringItem>();
					for (const pickOption of info.options) {
						const value = Types.isString(pickOption) ? pickOption : pickOption.value;
						const label = Types.isString(pickOption) ? undefined : pickOption.label;

						const item: PickStringItem = {
							label: label ? `${label}: ${value}` : value,
							value: value
						};

						if (value === info.default) {
							item.description = localize('inputVariable.defaultInputValue', "(Default)");
							picks.unshift(item);
						} else if (!info.default && value === previousPickedValue) {
							picks.unshift(item);
						} else {
							picks.push(item);
						}
					}

					const pickOptions: IPickOptions<PickStringItem> = { placeHolder: info.description, matchOnDetail: true, ignoreFocusLost: true };
					return this.userInputAccessQueue.queue(() => this.quickInputService.pick(picks, pickOptions, undefined)).then(resolvedInput => {
						if (resolvedInput) {
							const value = (resolvedInput as PickStringItem).value;
							this.storeInputLru(defaultValueMap.set(defaultValueKey, value));
							return value;
						}
						return undefined;
					});
				}

				case 'command': {
					if (!Types.isString(info.command)) {
						missingAttribute('command');
					}
					return this.userInputAccessQueue.queue(() => this.commandService.executeCommand<string>(info.command, info.args)).then(result => {
						if (typeof result === 'string' || Types.isUndefinedOrNull(result)) {
							return result;
						}
						throw new VariableError(VariableKind.Input, localize('inputVariable.command.noStringType', "Cannot substitute input variable '{0}' because command '{1}' did not return a result of type string.", variable, info.command));
					});
				}

				default:
					throw new VariableError(VariableKind.Input, localize('inputVariable.unknownType', "Input variable '{0}' can only be of type 'promptString', 'pickString', or 'command'.", variable));
			}
		}

		throw new VariableError(VariableKind.Input, localize('inputVariable.undefinedVariable', "Undefined input variable '{0}' encountered. Remove or define '{0}' to continue.", variable));
	}
}
