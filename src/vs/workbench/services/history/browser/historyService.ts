/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { URI } from 'vs/base/common/uri';
import { parse, stringify } from 'vs/base/common/marshalling';
import { IResourceEditorInput, IEditorOptions } from 'vs/platform/editor/common/editor';
import { IEditorPane, IEditorCloseEvent, EditorResourceAccessor, IEditorIdentifier, GroupIdentifier, EditorsOrder, SideBySideEditor, IUntypedEditorInput, isResourceEditorInput, isEditorInput, isSideBySideEditorInput, EditorCloseContext, IEditorPaneSelection, EditorPaneSelectionCompareResult, EditorPaneSelectionChangeReason, isEditorPaneWithSelection, IEditorPaneWithSelection, IEditorPaneSelectionChangeEvent } from 'vs/workbench/common/editor';
import { EditorInput } from 'vs/workbench/common/editor/editorInput';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IHistoryService } from 'vs/workbench/services/history/common/history';
import { FileChangesEvent, IFileService, FileChangeType, FILES_EXCLUDE_CONFIG, FileOperationEvent, FileOperation } from 'vs/platform/files/common/files';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { dispose, Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { Event } from 'vs/base/common/event';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { getExcludes, ISearchConfiguration, SEARCH_EXCLUDE_CONFIG } from 'vs/workbench/services/search/common/search';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { EditorServiceImpl } from 'vs/workbench/browser/parts/editor/editor';
import { IWorkbenchLayoutService } from 'vs/workbench/services/layout/browser/layoutService';
import { IContextKeyService, RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { coalesce, remove } from 'vs/base/common/arrays';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { addDisposableListener, EventType, EventHelper } from 'vs/base/browser/dom';
import { IWorkspacesService } from 'vs/platform/workspaces/common/workspaces';
import { Schemas } from 'vs/base/common/network';
import { onUnexpectedError } from 'vs/base/common/errors';
import { IdleValue } from 'vs/base/common/async';
import { ResourceGlobMatcher } from 'vs/workbench/common/resources';
import { IPathService } from 'vs/workbench/services/path/common/pathService';
import { IUriIdentityService } from 'vs/platform/uriIdentity/common/uriIdentity';
import { ILifecycleService, LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';

class EditorSelectionState {

	constructor(
		readonly editor: EditorInput,
		readonly selection: IEditorPaneSelection | undefined,
		readonly reason: EditorPaneSelectionChangeReason | undefined
	) { }

	justifiesNewNavigationEntry(other: EditorSelectionState): boolean {
		if (other.reason === EditorPaneSelectionChangeReason.NAVIGATION) {
			return true; // always let navigation sources win (e.g. "Go to definition" should add a history entry)
		}

		if (!this.editor.matches(other.editor)) {
			return true; // different editors
		}

		if (!this.selection || !other.selection) {
			return true; // unknown selections
		}

		return other.selection.compare(this.selection) === EditorPaneSelectionCompareResult.DIFFERENT;
	}
}

interface ISerializedEditorHistoryEntry {
	editor: IResourceEditorInput;
}

interface IEditorWithSelection {
	editor: EditorInput | IResourceEditorInput;
	selection?: IEditorPaneSelection;
}

interface IRecentlyClosedEditor {
	editorId: string | undefined;
	editor: IUntypedEditorInput;

	resource: URI | undefined;
	associatedResources: URI[];

	index: number;
	sticky: boolean;
}

export class HistoryService extends Disposable implements IHistoryService {

	declare readonly _serviceBrand: undefined;

	private static readonly MOUSE_NAVIGATION_SETTING = 'workbench.editor.mouseBackForwardToNavigate';

	private readonly activeEditorListeners = this._register(new DisposableStore());
	private lastActiveEditor: IEditorIdentifier | undefined = undefined;

	constructor(
		@IEditorService private readonly editorService: EditorServiceImpl,
		@IEditorGroupsService private readonly editorGroupService: IEditorGroupsService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IPathService private readonly pathService: IPathService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService
	) {
		super();

		this.registerListeners();

		// if the service is created late enough that an editor is already opened
		// make sure to trigger the onActiveEditorChanged() to track the editor
		// properly (fixes https://github.com/microsoft/vscode/issues/59908)
		if (this.editorService.activeEditorPane) {
			this.onDidActiveEditorChange();
		}
	}

	private registerListeners(): void {

		// Mouse back/forward support
		this.registerMouseNavigationListener();

		// Editor changes
		this._register(this.editorService.onDidActiveEditorChange(() => this.onDidActiveEditorChange()));
		this._register(this.editorService.onDidOpenEditorFail(event => this.remove(event.editor)));
		this._register(this.editorService.onDidCloseEditor(event => this.onDidCloseEditor(event)));
		this._register(this.editorService.onDidMostRecentlyActiveEditorsChange(() => this.handleEditorEventInRecentEditorsStack()));

		// File changes
		this._register(this.fileService.onDidFilesChange(event => this.onDidFilesChange(event)));
		this._register(this.fileService.onDidRunOperation(event => this.onDidFilesChange(event)));

		// Storage
		this._register(this.storageService.onWillSaveState(() => this.saveState()));
	}

	private registerMouseNavigationListener(): void {
		const mouseBackForwardSupportListener = this._register(new DisposableStore());
		const handleMouseBackForwardSupport = () => {
			mouseBackForwardSupportListener.clear();

			if (this.configurationService.getValue(HistoryService.MOUSE_NAVIGATION_SETTING)) {
				mouseBackForwardSupportListener.add(addDisposableListener(this.layoutService.container, EventType.MOUSE_DOWN, e => this.onMouseDown(e)));
			}
		};

		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(HistoryService.MOUSE_NAVIGATION_SETTING)) {
				handleMouseBackForwardSupport();
			}
		}));

		handleMouseBackForwardSupport();
	}

	private onMouseDown(event: MouseEvent): void {

		// Support to navigate in history when mouse buttons 4/5 are pressed
		switch (event.button) {
			case 3:
				EventHelper.stop(event);
				this.back();
				break;
			case 4:
				EventHelper.stop(event);
				this.forward();
				break;
		}
	}

	private onDidActiveEditorChange(): void {
		const activeEditorPane = this.editorService.activeEditorPane;
		if (this.lastActiveEditor && this.matchesEditor(this.lastActiveEditor, activeEditorPane)) {
			return; // return if the active editor is still the same
		}

		// Remember as last active editor (can be undefined if none opened)
		this.lastActiveEditor = activeEditorPane?.input && activeEditorPane.group ? { editor: activeEditorPane.input, groupId: activeEditorPane.group.id } : undefined;

		// Dispose old listeners
		this.activeEditorListeners.clear();

		// Handle editor change
		this.handleActiveEditorChange(activeEditorPane);

		// Listen to selection changes if the editor pane
		// is having a selection concept.
		if (activeEditorPane && isEditorPaneWithSelection(activeEditorPane)) {

			// Debounce the selection event with a timeout of 0ms so that
			// multiple selection change events are folded into one.

			this.activeEditorListeners.add(Event.debouncedListener<IEditorPaneSelectionChangeEvent>(activeEditorPane.onDidChangeSelection, mergedEvent => {

				// Handle in editor navigation stack
				this.handleActiveEditorSelectionChangeEvent(activeEditorPane, mergedEvent);

				// Handle as last edit location (if editing)
				if (mergedEvent.reason === EditorPaneSelectionChangeReason.EDIT) {
					this.rememberLastEditLocation(activeEditorPane);
				}
			}, (last, current) => {

				// Since we specially handle selection changes from edits,
				// make sure to preserve that reason when handling multiple
				// events at once.

				let reason: EditorPaneSelectionChangeReason;
				if (last?.reason === EditorPaneSelectionChangeReason.EDIT) {
					reason = last.reason;
				} else {
					reason = current.reason;
				}

				return { reason };
			}, 0));
		}
	}

	private matchesEditor(identifier: IEditorIdentifier, editorPane?: IEditorPane): boolean {
		if (!editorPane || !editorPane.group) {
			return false;
		}

		if (identifier.groupId !== editorPane.group.id) {
			return false;
		}

		return editorPane.input ? identifier.editor.matches(editorPane.input) : false;
	}

	private onDidFilesChange(event: FileChangesEvent | FileOperationEvent): void {

		// External file changes (watcher)
		if (event instanceof FileChangesEvent) {
			if (event.gotDeleted()) {
				this.remove(event);
			}
		}

		// Internal file changes (e.g. explorer)
		else {

			// Delete
			if (event.isOperation(FileOperation.DELETE)) {
				this.remove(event);
			}

			// Move
			else if (event.isOperation(FileOperation.MOVE) && event.target.isFile) {
				this.move(event);
			}
		}
	}

	private handleActiveEditorChange(editorPane?: IEditorPane): void {
		this.handleEditorEventInHistory(editorPane);
		this.handleEventInEditorNavigationStack(editorPane);
	}

	private handleActiveEditorSelectionChangeEvent(editorPane: IEditorPane, event: IEditorPaneSelectionChangeEvent): void {
		this.handleEventInEditorNavigationStack(editorPane, event);
	}

	private onEditorDispose(editor: EditorInput, listener: Function, mapEditorToDispose: Map<EditorInput, DisposableStore>): void {
		const toDispose = Event.once(editor.onWillDispose)(() => listener());

		let disposables = mapEditorToDispose.get(editor);
		if (!disposables) {
			disposables = new DisposableStore();
			mapEditorToDispose.set(editor, disposables);
		}

		disposables.add(toDispose);
	}

	private clearOnEditorDispose(editor: EditorInput | IResourceEditorInput | FileChangesEvent | FileOperationEvent, mapEditorToDispose: Map<EditorInput, DisposableStore>): void {
		if (!isEditorInput(editor)) {
			return; // only supported when passing in an actual editor input
		}

		const disposables = mapEditorToDispose.get(editor);
		if (disposables) {
			dispose(disposables);
			mapEditorToDispose.delete(editor);
		}
	}

	private move(event: FileOperationEvent): void {
		this.moveInHistory(event);
		this.moveInEditorNavigationStack(event);
	}

	private remove(editor: EditorInput): void;
	private remove(event: FileChangesEvent): void;
	private remove(event: FileOperationEvent): void;
	private remove(arg1: EditorInput | FileChangesEvent | FileOperationEvent): void {
		this.removeFromHistory(arg1);
		this.removeFromEditorNavigationStack(arg1);
		this.removeFromRecentlyClosedEditors(arg1);
		this.removeFromRecentlyOpened(arg1);
	}

	private removeFromRecentlyOpened(arg1: EditorInput | FileChangesEvent | FileOperationEvent): void {
		let resource: URI | undefined = undefined;
		if (isEditorInput(arg1)) {
			resource = EditorResourceAccessor.getOriginalUri(arg1);
		} else if (arg1 instanceof FileChangesEvent) {
			// Ignore for now (recently opened are most often out of workspace files anyway for which there are no file events)
		} else {
			resource = arg1.resource;
		}

		if (resource) {
			this.workspacesService.removeRecentlyOpened([resource]);
		}
	}

	clear(): void {

		// History
		this.clearRecentlyOpened();

		// Navigation (next, previous)
		this.editorNavigationStackIndex = -1;
		this.lastEditorNavigationStackIndex = -1;
		this.editorNavigationStack.splice(0);

		for (const [, disposable] of this.editorNavigationStackListeners) {
			dispose(disposable);
		}
		this.editorNavigationStackListeners.clear();

		// Recently closed editors
		this.recentlyClosedEditors = [];

		// Context Keys
		this.updateContextKeys();
	}

	//#region History Context Keys

	private readonly canNavigateBackContextKey = (new RawContextKey<boolean>('canNavigateBack', false, localize('canNavigateBack', "Whether it is possible to navigate back in editor history"))).bindTo(this.contextKeyService);
	private readonly canNavigateForwardContextKey = (new RawContextKey<boolean>('canNavigateForward', false, localize('canNavigateForward', "Whether it is possible to navigate forward in editor history"))).bindTo(this.contextKeyService);
	private readonly canNavigateToLastEditLocationContextKey = (new RawContextKey<boolean>('canNavigateToLastEditLocation', false, localize('canNavigateToLastEditLocation', "Whether it is possible to navigate to the last edit location"))).bindTo(this.contextKeyService);
	private readonly canReopenClosedEditorContextKey = (new RawContextKey<boolean>('canReopenClosedEditor', false, localize('canReopenClosedEditor', "Whether it is possible to reopen the last closed editor"))).bindTo(this.contextKeyService);

	private updateContextKeys(): void {
		this.contextKeyService.bufferChangeEvents(() => {
			this.canNavigateBackContextKey.set(this.editorNavigationStack.length > 0 && this.editorNavigationStackIndex > 0);
			this.canNavigateForwardContextKey.set(this.editorNavigationStack.length > 0 && this.editorNavigationStackIndex < this.editorNavigationStack.length - 1);
			this.canNavigateToLastEditLocationContextKey.set(!!this.lastEditLocation);
			this.canReopenClosedEditorContextKey.set(this.recentlyClosedEditors.length > 0);
		});
	}

	//#endregion

	//#region Navigation: Go Forward, Go Backward (limit: 50)

	private static readonly MAX_EDITOR_NAVIGATION_STACK_ITEMS = 50;

	private readonly editorNavigationStackListeners = new Map<EditorInput, DisposableStore>();

	private editorNavigationStack: IEditorWithSelection[] = [];
	private editorNavigationStackIndex = -1;
	private lastEditorNavigationStackIndex = -1;

	private navigatingInEditorStack = false;

	private currentEditorSelectionState: EditorSelectionState | undefined = undefined;

	forward(): void {
		if (this.editorNavigationStack.length > this.editorNavigationStackIndex + 1) {
			this.setIndex(this.editorNavigationStackIndex + 1);
			this.navigate();
		}
	}

	back(): void {
		if (this.editorNavigationStackIndex > 0) {
			this.setIndex(this.editorNavigationStackIndex - 1);
			this.navigate();
		}
	}

	last(): void {
		if (this.lastEditorNavigationStackIndex === -1) {
			this.back();
		} else {
			this.setIndex(this.lastEditorNavigationStackIndex);
			this.navigate();
		}
	}

	private setIndex(value: number): void {
		this.lastEditorNavigationStackIndex = this.editorNavigationStackIndex;
		this.editorNavigationStackIndex = value;

		// Context Keys
		this.updateContextKeys();
	}

	private async navigate(): Promise<void> {
		this.navigatingInEditorStack = true;

		try {
			await this.doNavigate(this.editorNavigationStack[this.editorNavigationStackIndex]);
		} finally {
			this.navigatingInEditorStack = false;
		}
	}

	private doNavigate(location: IEditorWithSelection): Promise<IEditorPane | undefined> {
		const options: IEditorOptions = {
			revealIfOpened: true // support to navigate across editor groups
		};

		// Apply selection if any
		location.selection?.restore(options);

		if (isEditorInput(location.editor)) {
			return this.editorService.openEditor(location.editor, options);
		}

		return this.editorService.openEditor({
			...location.editor,
			options: {
				...location.editor.options,
				...options
			}
		});
	}

	private handleEventInEditorNavigationStack(editorPane: IEditorPane | undefined, event?: IEditorPaneSelectionChangeEvent): void {
		const isSelectionAwareEditorPane = editorPane && isEditorPaneWithSelection(editorPane);

		// Treat editor changes that happen as part of stack navigation specially
		// we do not want to add a new stack entry as a matter of navigating the
		// stack but we need to keep our currentEditorSelectionState up to date
		// with the navigtion that occurs.
		if (this.navigatingInEditorStack) {
			if (isSelectionAwareEditorPane && editorPane?.input && !editorPane.input.isDisposed()) {
				this.currentEditorSelectionState = new EditorSelectionState(editorPane.input, editorPane.getSelection(), event?.reason);
			} else {
				this.currentEditorSelectionState = undefined; // we navigated to a non-selection aware or disposed editor
			}
		}

		// Normal navigation not part of stack navigation
		else {

			// Navigation inside selection aware editor
			if (isSelectionAwareEditorPane && editorPane?.input && !editorPane.input.isDisposed()) {
				this.handleSelectionAwareEditorEventInEditorNavigationStack(editorPane, editorPane.input, event);
			}

			// Navigation to non-selection aware or disposed editor
			else {
				this.currentEditorSelectionState = undefined; // at this time we have no active selection aware editor

				if (editorPane?.input && !editorPane.input.isDisposed()) {
					this.handleNonSelectionAwareEditorEventInEditorNavigationStack(editorPane);
				}
			}
		}
	}

	private handleSelectionAwareEditorEventInEditorNavigationStack(editorPane: IEditorPaneWithSelection, editor: EditorInput, event?: IEditorPaneSelectionChangeEvent): void {
		const stateCandidate = new EditorSelectionState(editor, editorPane.getSelection(), event?.reason);

		// Add to stack if we dont have a current state or this new state justifies a push
		if (!this.currentEditorSelectionState || this.currentEditorSelectionState.justifiesNewNavigationEntry(stateCandidate)) {
			this.addToEditorNavigationStack(editor, stateCandidate.selection);
		}

		// Otherwise we replace the current stack entry with this one
		else {
			this.replaceInEditorNavigationStack(editor, stateCandidate.selection);
		}

		// Update our current text editor state
		this.currentEditorSelectionState = stateCandidate;
	}

	private handleNonSelectionAwareEditorEventInEditorNavigationStack(editorPane: IEditorPane): void {
		if (!editorPane.input) {
			return;
		}

		const currentStack = this.editorNavigationStack[this.editorNavigationStackIndex];
		if (currentStack && this.matches(editorPane.input, currentStack.editor)) {
			return; // do not push same editor input again
		}

		this.addToEditorNavigationStack(editorPane.input);
	}

	private addToEditorNavigationStack(editor: EditorInput | IResourceEditorInput, selection?: IEditorPaneSelection): void {
		if (!this.navigatingInEditorStack) {
			this.doAddOrReplaceInEditorNavigationStack(editor, selection);
		}
	}

	private replaceInEditorNavigationStack(editor: EditorInput | IResourceEditorInput, selection?: IEditorPaneSelection): void {
		if (!this.navigatingInEditorStack) {
			this.doAddOrReplaceInEditorNavigationStack(editor, selection, true /* force replace */);
		}
	}

	private doAddOrReplaceInEditorNavigationStack(editor: EditorInput | IResourceEditorInput, selection?: IEditorPaneSelection, forceReplace?: boolean): void {

		// Check whether to replace an existing entry or not
		let replace = false;
		const currentEntry = this.editorNavigationStack[this.editorNavigationStackIndex];
		if (currentEntry) {
			if (forceReplace) {
				replace = true; // replace if we are forced to
			} else if (this.matches(currentEntry.editor, editor) && this.shouldReplaceEditorPaneSelection(currentEntry, selection)) {
				replace = true; // replace if the input is the same and selection indicates as such
			}
		}

		const stackEditorInput = this.preferResourceEditorInput(editor);
		if (!stackEditorInput) {
			return;
		}

		const entry = { editor: stackEditorInput, selection };

		// Replace at current position
		let removedEntries: IEditorWithSelection[] = [];
		if (replace) {
			removedEntries.push(this.editorNavigationStack[this.editorNavigationStackIndex]);
			this.editorNavigationStack[this.editorNavigationStackIndex] = entry;
		}

		// Add to stack at current position
		else {

			// If we are not at the end of history, we remove anything after
			if (this.editorNavigationStack.length > this.editorNavigationStackIndex + 1) {
				for (let i = this.editorNavigationStackIndex + 1; i < this.editorNavigationStack.length; i++) {
					removedEntries.push(this.editorNavigationStack[i]);
				}

				this.editorNavigationStack = this.editorNavigationStack.slice(0, this.editorNavigationStackIndex + 1);
			}

			// Insert entry at index
			this.editorNavigationStack.splice(this.editorNavigationStackIndex + 1, 0, entry);

			// Check for limit
			if (this.editorNavigationStack.length > HistoryService.MAX_EDITOR_NAVIGATION_STACK_ITEMS) {
				removedEntries.push(this.editorNavigationStack.shift()!); // remove first
				if (this.lastEditorNavigationStackIndex >= 0) {
					this.lastEditorNavigationStackIndex--;
				}
			} else {
				this.setIndex(this.editorNavigationStackIndex + 1);
			}
		}

		// Clear editor listeners from removed entries
		for (const removedEntry of removedEntries) {
			this.clearOnEditorDispose(removedEntry.editor, this.editorNavigationStackListeners);
		}

		// Remove this from the stack unless the stack input is a resource
		// that can easily be restored even when the input gets disposed
		if (isEditorInput(stackEditorInput)) {
			this.onEditorDispose(stackEditorInput, () => this.removeFromEditorNavigationStack(stackEditorInput), this.editorNavigationStackListeners);
		}

		// Context Keys
		this.updateContextKeys();
	}

	private preferResourceEditorInput(editor: EditorInput): EditorInput | IResourceEditorInput;
	private preferResourceEditorInput(editor: IResourceEditorInput): IResourceEditorInput | undefined;
	private preferResourceEditorInput(editor: EditorInput | IResourceEditorInput): EditorInput | IResourceEditorInput | undefined;
	private preferResourceEditorInput(editor: EditorInput | IResourceEditorInput): EditorInput | IResourceEditorInput | undefined {
		const resource = EditorResourceAccessor.getOriginalUri(editor);

		// For now, only prefer well known schemes that we control to prevent
		// issues such as https://github.com/microsoft/vscode/issues/85204
		// from being used as resource inputs
		// resource inputs survive editor disposal and as such are a lot more
		// durable across editor changes and restarts
		const hasValidResourceEditorInputScheme =
			resource?.scheme === Schemas.file ||
			resource?.scheme === Schemas.vscodeRemote ||
			resource?.scheme === Schemas.userData ||
			resource?.scheme === this.pathService.defaultUriScheme;

		// Scheme is valid: prefer the untyped input
		// over the typed input if possible to keep
		// the entry across restarts
		if (hasValidResourceEditorInputScheme) {
			if (isEditorInput(editor)) {
				const untypedInput = editor.toUntyped();
				if (isResourceEditorInput(untypedInput)) {
					return untypedInput;
				}
			}

			return editor;
		}

		// Scheme is invalid: allow the editor input
		// for as long as it is not disposed
		else {
			return isEditorInput(editor) ? editor : undefined;
		}
	}

	private shouldReplaceEditorPaneSelection(stackEntry: IEditorWithSelection, newSelection?: IEditorPaneSelection): boolean {
		if (!stackEntry.selection) {
			return true; // always replace when we have no specific selection yet
		}

		if (!newSelection) {
			return false; // otherwise, prefer to keep existing specific selection over new unspecific one
		}

		// Finally, replace when selections are considered identical
		return stackEntry.selection.compare(newSelection) === EditorPaneSelectionCompareResult.IDENTICAL;
	}

	private moveInEditorNavigationStack(event: FileOperationEvent): void {
		const removed = this.removeFromEditorNavigationStack(event);
		if (removed && event.target) {
			this.addToEditorNavigationStack({ resource: event.target.resource });
		}
	}

	private removeFromEditorNavigationStack(arg1: EditorInput | FileChangesEvent | FileOperationEvent): boolean {
		let removed = false;

		this.editorNavigationStack = this.editorNavigationStack.filter(entry => {
			const matches = this.matches(arg1, entry.editor);

			// Cleanup any listeners associated with the input when removing
			if (matches) {
				this.clearOnEditorDispose(arg1, this.editorNavigationStackListeners);
				removed = true;
			}

			return !matches;
		});
		this.editorNavigationStackIndex = this.editorNavigationStack.length - 1; // reset index
		this.lastEditorNavigationStackIndex = -1;

		// Context Keys
		this.updateContextKeys();

		return removed;
	}

	private matches(arg1: EditorInput | IResourceEditorInput | FileChangesEvent | FileOperationEvent, inputB: EditorInput | IResourceEditorInput): boolean {
		if (arg1 instanceof FileChangesEvent || arg1 instanceof FileOperationEvent) {
			if (isEditorInput(inputB)) {
				return false; // we only support this for `IResourceEditorInputs` that are file based
			}

			if (arg1 instanceof FileChangesEvent) {
				return arg1.contains(inputB.resource, FileChangeType.DELETED);
			}

			return this.matchesFile(inputB.resource, arg1);
		}

		if (isEditorInput(arg1)) {
			if (isEditorInput(inputB)) {
				return arg1.matches(inputB);
			}

			return this.matchesFile(inputB.resource, arg1);
		}

		if (isEditorInput(inputB)) {
			return this.matchesFile(arg1.resource, inputB);
		}

		return arg1 && inputB && this.uriIdentityService.extUri.isEqual(arg1.resource, inputB.resource);
	}

	private matchesFile(resource: URI, arg2: EditorInput | IResourceEditorInput | FileChangesEvent | FileOperationEvent): boolean {
		if (arg2 instanceof FileChangesEvent) {
			return arg2.contains(resource, FileChangeType.DELETED);
		}

		if (arg2 instanceof FileOperationEvent) {
			return this.uriIdentityService.extUri.isEqualOrParent(resource, arg2.resource);
		}

		if (isEditorInput(arg2)) {
			const inputResource = arg2.resource;
			if (!inputResource) {
				return false;
			}

			if (this.lifecycleService.phase >= LifecyclePhase.Restored && !this.fileService.hasProvider(inputResource)) {
				return false; // make sure to only check this when workbench has restored (for https://github.com/microsoft/vscode/issues/48275)
			}

			return this.uriIdentityService.extUri.isEqual(inputResource, resource);
		}

		return this.uriIdentityService.extUri.isEqual(arg2?.resource, resource);
	}

	//#endregion

	//#region Navigation: Next/Previous Used Editor

	private recentlyUsedEditorsStack: readonly IEditorIdentifier[] | undefined = undefined;
	private recentlyUsedEditorsStackIndex = 0;

	private recentlyUsedEditorsInGroupStack: readonly IEditorIdentifier[] | undefined = undefined;
	private recentlyUsedEditorsInGroupStackIndex = 0;

	private navigatingInRecentlyUsedEditorsStack = false;
	private navigatingInRecentlyUsedEditorsInGroupStack = false;

	openNextRecentlyUsedEditor(groupId?: GroupIdentifier): void {
		const [stack, index] = this.ensureRecentlyUsedStack(index => index - 1, groupId);

		this.doNavigateInRecentlyUsedEditorsStack(stack[index], groupId);
	}

	openPreviouslyUsedEditor(groupId?: GroupIdentifier): void {
		const [stack, index] = this.ensureRecentlyUsedStack(index => index + 1, groupId);

		this.doNavigateInRecentlyUsedEditorsStack(stack[index], groupId);
	}

	private async doNavigateInRecentlyUsedEditorsStack(editorIdentifier: IEditorIdentifier | undefined, groupId?: GroupIdentifier): Promise<void> {
		if (editorIdentifier) {
			const acrossGroups = typeof groupId !== 'number' || !this.editorGroupService.getGroup(groupId);

			if (acrossGroups) {
				this.navigatingInRecentlyUsedEditorsStack = true;
			} else {
				this.navigatingInRecentlyUsedEditorsInGroupStack = true;
			}

			const group = this.editorGroupService.getGroup(editorIdentifier.groupId) ?? this.editorGroupService.activeGroup;
			try {
				await group.openEditor(editorIdentifier.editor);
			} finally {
				if (acrossGroups) {
					this.navigatingInRecentlyUsedEditorsStack = false;
				} else {
					this.navigatingInRecentlyUsedEditorsInGroupStack = false;
				}
			}
		}
	}

	private ensureRecentlyUsedStack(indexModifier: (index: number) => number, groupId?: GroupIdentifier): [readonly IEditorIdentifier[], number] {
		let editors: readonly IEditorIdentifier[];
		let index: number;

		const group = typeof groupId === 'number' ? this.editorGroupService.getGroup(groupId) : undefined;

		// Across groups
		if (!group) {
			editors = this.recentlyUsedEditorsStack || this.editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE);
			index = this.recentlyUsedEditorsStackIndex;
		}

		// Within group
		else {
			editors = this.recentlyUsedEditorsInGroupStack || group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).map(editor => ({ groupId: group.id, editor }));
			index = this.recentlyUsedEditorsInGroupStackIndex;
		}

		// Adjust index
		let newIndex = indexModifier(index);
		if (newIndex < 0) {
			newIndex = 0;
		} else if (newIndex > editors.length - 1) {
			newIndex = editors.length - 1;
		}

		// Remember index and editors
		if (!group) {
			this.recentlyUsedEditorsStack = editors;
			this.recentlyUsedEditorsStackIndex = newIndex;
		} else {
			this.recentlyUsedEditorsInGroupStack = editors;
			this.recentlyUsedEditorsInGroupStackIndex = newIndex;
		}

		return [editors, newIndex];
	}

	private handleEditorEventInRecentEditorsStack(): void {

		// Drop all-editors stack unless navigating in all editors
		if (!this.navigatingInRecentlyUsedEditorsStack) {
			this.recentlyUsedEditorsStack = undefined;
			this.recentlyUsedEditorsStackIndex = 0;
		}

		// Drop in-group-editors stack unless navigating in group
		if (!this.navigatingInRecentlyUsedEditorsInGroupStack) {
			this.recentlyUsedEditorsInGroupStack = undefined;
			this.recentlyUsedEditorsInGroupStackIndex = 0;
		}
	}

	//#endregion

	//#region File: Reopen Closed Editor (limit: 20)

	private static readonly MAX_RECENTLY_CLOSED_EDITORS = 20;

	private recentlyClosedEditors: IRecentlyClosedEditor[] = [];
	private ignoreEditorCloseEvent = false;

	private onDidCloseEditor(event: IEditorCloseEvent): void {
		if (this.ignoreEditorCloseEvent) {
			return; // blocked
		}

		const { editor, context } = event;
		if (context === EditorCloseContext.REPLACE || context === EditorCloseContext.MOVE) {
			return; // ignore if editor was replaced or moved
		}

		const untypedEditor = editor.toUntyped();
		if (!untypedEditor) {
			return; // we need a untyped editor to restore from going forward
		}

		const associatedResources: URI[] = [];
		const editorResource = EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.BOTH });
		if (URI.isUri(editorResource)) {
			associatedResources.push(editorResource);
		} else if (editorResource) {
			associatedResources.push(...coalesce([editorResource.primary, editorResource.secondary]));
		}

		// Remove from list of recently closed before...
		this.removeFromRecentlyClosedEditors(editor);

		// ...adding it as last recently closed
		this.recentlyClosedEditors.push({
			editorId: editor.editorId,
			editor: untypedEditor,
			resource: EditorResourceAccessor.getOriginalUri(editor),
			associatedResources,
			index: event.index,
			sticky: event.sticky
		});

		// Bounding
		if (this.recentlyClosedEditors.length > HistoryService.MAX_RECENTLY_CLOSED_EDITORS) {
			this.recentlyClosedEditors.shift();
		}

		// Context
		this.canReopenClosedEditorContextKey.set(true);
	}

	reopenLastClosedEditor(): void {

		// Open editor if we have one
		const lastClosedEditor = this.recentlyClosedEditors.pop();
		if (lastClosedEditor) {
			this.doReopenLastClosedEditor(lastClosedEditor);
		}

		// Update context
		this.canReopenClosedEditorContextKey.set(this.recentlyClosedEditors.length > 0);
	}

	private async doReopenLastClosedEditor(lastClosedEditor: IRecentlyClosedEditor): Promise<void> {
		const options: IEditorOptions = { pinned: true, sticky: lastClosedEditor.sticky, index: lastClosedEditor.index, ignoreError: true };

		// Special sticky handling: remove the index property from options
		// if that would result in sticky state to not preserve or apply
		// wrongly.
		if (
			(lastClosedEditor.sticky && !this.editorGroupService.activeGroup.isSticky(lastClosedEditor.index)) ||
			(!lastClosedEditor.sticky && this.editorGroupService.activeGroup.isSticky(lastClosedEditor.index))
		) {
			options.index = undefined;
		}

		// Re-open editor unless already opened
		let editorPane: IEditorPane | undefined = undefined;
		if (!this.editorGroupService.activeGroup.contains(lastClosedEditor.editor)) {

			// Fix for https://github.com/microsoft/vscode/issues/107850
			// If opening an editor fails, it is possible that we get
			// another editor-close event as a result. But we really do
			// want to ignore that in our list of recently closed editors
			//  to prevent endless loops.

			this.ignoreEditorCloseEvent = true;
			try {
				editorPane = await this.editorService.openEditor({
					...lastClosedEditor.editor,
					options: {
						...lastClosedEditor.editor.options,
						...options
					}
				});
			} finally {
				this.ignoreEditorCloseEvent = false;
			}
		}

		// If no editor was opened, try with the next one
		if (!editorPane) {

			// Fix for https://github.com/microsoft/vscode/issues/67882
			// If opening of the editor fails, make sure to try the next one
			// but make sure to remove this one from the list to prevent
			// endless loops.
			remove(this.recentlyClosedEditors, lastClosedEditor);

			// Try with next one
			this.reopenLastClosedEditor();
		}
	}

	private removeFromRecentlyClosedEditors(arg1: EditorInput | FileChangesEvent | FileOperationEvent): void {
		this.recentlyClosedEditors = this.recentlyClosedEditors.filter(recentlyClosedEditor => {
			if (isEditorInput(arg1) && recentlyClosedEditor.editorId !== arg1.editorId) {
				return true; // keep: different editor identifiers
			}

			if (recentlyClosedEditor.resource && this.matchesFile(recentlyClosedEditor.resource, arg1)) {
				return false; // remove: editor matches directly
			}

			if (recentlyClosedEditor.associatedResources.some(associatedResource => this.matchesFile(associatedResource, arg1))) {
				return false; // remove: an associated resource matches
			}

			return true; // keep
		});

		// Update context
		this.canReopenClosedEditorContextKey.set(this.recentlyClosedEditors.length > 0);
	}

	//#endregion

	//#region Go to: Last Edit Location (limit: 1)

	private lastEditLocation: IEditorWithSelection | undefined;

	private rememberLastEditLocation(editorPane: IEditorPane): void {
		const editor = editorPane.input;
		if (!editor || editor.isDisposed()) {
			return;
		}

		this.lastEditLocation = { editor, selection: editorPane.getSelection?.() };
		this.canNavigateToLastEditLocationContextKey.set(true);
	}

	openLastEditLocation(): void {
		if (this.lastEditLocation) {
			this.doNavigate(this.lastEditLocation);
		}
	}

	//#endregion

	//#region Go to: Recently Opened Editor (limit: 200, persisted)

	private static readonly MAX_HISTORY_ITEMS = 200;
	private static readonly HISTORY_STORAGE_KEY = 'history.entries';

	private history: Array<EditorInput | IResourceEditorInput> | undefined = undefined;

	private readonly editorHistoryListeners = new Map<EditorInput, DisposableStore>();

	private readonly resourceExcludeMatcher = this._register(new IdleValue(() => {
		const matcher = this._register(this.instantiationService.createInstance(
			ResourceGlobMatcher,
			root => getExcludes(root ? this.configurationService.getValue<ISearchConfiguration>({ resource: root }) : this.configurationService.getValue<ISearchConfiguration>()) || Object.create(null),
			event => event.affectsConfiguration(FILES_EXCLUDE_CONFIG) || event.affectsConfiguration(SEARCH_EXCLUDE_CONFIG)
		));

		this._register(matcher.onExpressionChange(() => this.removeExcludedFromHistory()));

		return matcher;
	}));

	private handleEditorEventInHistory(editorPane?: IEditorPane): void {

		// Ensure we have not configured to exclude input and don't track invalid inputs
		const editor = editorPane?.input;
		if (!editor || editor.isDisposed() || !this.includeInHistory(editor)) {
			return;
		}

		// Remove any existing entry and add to the beginning
		this.removeFromHistory(editor);
		this.addToHistory(editor);
	}

	private addToHistory(editor: EditorInput | IResourceEditorInput, insertFirst = true): void {
		this.ensureHistoryLoaded(this.history);

		const historyInput = this.preferResourceEditorInput(editor);
		if (!historyInput) {
			return;
		}

		// Insert based on preference
		if (insertFirst) {
			this.history.unshift(historyInput);
		} else {
			this.history.push(historyInput);
		}

		// Respect max entries setting
		if (this.history.length > HistoryService.MAX_HISTORY_ITEMS) {
			this.clearOnEditorDispose(this.history.pop()!, this.editorHistoryListeners);
		}

		// React to editor input disposing if this is a typed editor
		if (isEditorInput(historyInput)) {
			this.onEditorDispose(historyInput, () => this.updateHistoryOnEditorDispose(historyInput), this.editorHistoryListeners);
		}
	}

	private updateHistoryOnEditorDispose(editor: EditorInput): void {

		// Any non side-by-side editor input gets removed directly on dispose
		if (!isSideBySideEditorInput(editor)) {
			this.removeFromHistory(editor);
		}

		// Side-by-side editors get special treatment: we try to distill the
		// possibly untyped resource inputs from both sides to be able to
		// offer these entries from the history to the user still.
		else {
			const resourceInputs: IResourceEditorInput[] = [];
			const sideInputs = editor.primary.matches(editor.secondary) ? [editor.primary] : [editor.primary, editor.secondary];
			for (const sideInput of sideInputs) {
				const candidateResourceInput = this.preferResourceEditorInput(sideInput);
				if (isResourceEditorInput(candidateResourceInput)) {
					resourceInputs.push(candidateResourceInput);
				}
			}

			// Insert the untyped resource inputs where our disposed
			// side-by-side editor input is in the history stack
			this.replaceInHistory(editor, ...resourceInputs);
		}
	}

	private includeInHistory(editor: EditorInput | IResourceEditorInput): boolean {
		if (isEditorInput(editor)) {
			return true; // include any non files
		}

		return !this.resourceExcludeMatcher.value.matches(editor.resource);
	}

	private removeExcludedFromHistory(): void {
		this.ensureHistoryLoaded(this.history);

		this.history = this.history.filter(entry => {
			const include = this.includeInHistory(entry);

			// Cleanup any listeners associated with the input when removing from history
			if (!include) {
				this.clearOnEditorDispose(entry, this.editorHistoryListeners);
			}

			return include;
		});
	}

	private moveInHistory(event: FileOperationEvent): void {
		const removed = this.removeFromHistory(event);
		if (removed && event.target) {
			this.addToHistory({ resource: event.target.resource });
		}
	}

	removeFromHistory(arg1: EditorInput | IResourceEditorInput | FileChangesEvent | FileOperationEvent): boolean {
		let removed = false;

		this.ensureHistoryLoaded(this.history);

		this.history = this.history.filter(entry => {
			const matches = this.matches(arg1, entry);

			// Cleanup any listeners associated with the input when removing from history
			if (matches) {
				this.clearOnEditorDispose(arg1, this.editorHistoryListeners);
				removed = true;
			}

			return !matches;
		});

		return removed;
	}

	private replaceInHistory(editor: EditorInput | IResourceEditorInput, ...replacements: ReadonlyArray<EditorInput | IResourceEditorInput>): void {
		this.ensureHistoryLoaded(this.history);

		let replaced = false;

		const newHistory: Array<EditorInput | IResourceEditorInput> = [];
		for (const entry of this.history) {

			// Entry matches and is going to be disposed + replaced
			if (this.matches(editor, entry)) {

				// Cleanup any listeners associated with the input when replacing from history
				this.clearOnEditorDispose(editor, this.editorHistoryListeners);

				// Insert replacements but only once
				if (!replaced) {
					newHistory.push(...replacements);
					replaced = true;
				}
			}

			// Entry does not match, but only add it if it didn't match
			// our replacements already
			else if (!replacements.some(replacement => this.matches(replacement, entry))) {
				newHistory.push(entry);
			}
		}

		// If the target editor to replace was not found, make sure to
		// insert the replacements to the end to ensure we got them
		if (!replaced) {
			newHistory.push(...replacements);
		}

		this.history = newHistory;
	}

	clearRecentlyOpened(): void {
		this.history = [];

		for (const [, disposable] of this.editorHistoryListeners) {
			dispose(disposable);
		}
		this.editorHistoryListeners.clear();
	}

	getHistory(): readonly (EditorInput | IResourceEditorInput)[] {
		this.ensureHistoryLoaded(this.history);

		return this.history;
	}

	private ensureHistoryLoaded(history: Array<EditorInput | IResourceEditorInput> | undefined): asserts history {
		if (!this.history) {

			// Until history is loaded, it is just empty
			this.history = [];

			// We want to seed history from opened editors
			// too as well as previous stored state, so we
			// need to wait for the editor groups being ready
			if (this.editorGroupService.isReady) {
				this.loadHistory();
			} else {
				(async () => {
					await this.editorGroupService.whenReady;

					this.loadHistory();
				})();
			}
		}
	}

	private loadHistory(): void {

		// Init as empty before adding - since we are about to
		// populate the history from opened editors, we capture
		// the right order here.
		this.history = [];

		// All stored editors from previous session
		const storedEditorHistory = this.loadHistoryFromStorage();

		// All restored editors from previous session
		// in reverse editor from least to most recently
		// used.
		const openedEditorsLru = [...this.editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)].reverse();

		// We want to merge the opened editors from the last
		// session with the stored editors from the last
		// session. Because not all editors can be serialised
		// we want to make sure to include all opened editors
		// too.
		// Opened editors should always be first in the history

		const handledEditors = new Set<string /* resource + editorId */>();

		// Add all opened editors first
		for (const { editor } of openedEditorsLru) {
			if (!this.includeInHistory(editor)) {
				continue;
			}

			// Add into history
			this.addToHistory(editor);

			// Remember as added
			if (editor.resource) {
				handledEditors.add(`${editor.resource.toString()}/${editor.editorId}`);
			}
		}

		// Add remaining from storage if not there already
		// We check on resource and `editorId` (from `override`)
		// to figure out if the editor has been already added.
		for (const editor of storedEditorHistory) {
			if (!handledEditors.has(`${editor.resource.toString()}/${editor.options?.override}`)) {
				this.addToHistory(editor, false /* at the end */);
			}
		}
	}

	private loadHistoryFromStorage(): Array<IResourceEditorInput> {
		let entries: ISerializedEditorHistoryEntry[] = [];

		const entriesRaw = this.storageService.get(HistoryService.HISTORY_STORAGE_KEY, StorageScope.WORKSPACE);
		if (entriesRaw) {
			try {
				entries = coalesce(parse(entriesRaw));
			} catch (error) {
				onUnexpectedError(error); // https://github.com/microsoft/vscode/issues/99075
			}
		}

		return coalesce(entries.map(entry => entry.editor));
	}

	private saveState(): void {
		if (!this.history) {
			return; // nothing to save because history was not used
		}

		const entries: ISerializedEditorHistoryEntry[] = [];
		for (const editor of this.history) {
			if (isEditorInput(editor) || !isResourceEditorInput(editor)) {
				continue; // only save resource editor inputs
			}

			entries.push({ editor });
		}

		this.storageService.store(HistoryService.HISTORY_STORAGE_KEY, stringify(entries), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	//#endregion

	//#region Last Active Workspace/File

	getLastActiveWorkspaceRoot(schemeFilter?: string): URI | undefined {

		// No Folder: return early
		const folders = this.contextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}

		// Single Folder: return early
		if (folders.length === 1) {
			const resource = folders[0].uri;
			if (!schemeFilter || resource.scheme === schemeFilter) {
				return resource;
			}

			return undefined;
		}

		// Multiple folders: find the last active one
		for (const input of this.getHistory()) {
			if (isEditorInput(input)) {
				continue;
			}

			if (schemeFilter && input.resource.scheme !== schemeFilter) {
				continue;
			}

			const resourceWorkspace = this.contextService.getWorkspaceFolder(input.resource);
			if (resourceWorkspace) {
				return resourceWorkspace.uri;
			}
		}

		// Fallback to first workspace matching scheme filter if any
		for (const folder of folders) {
			const resource = folder.uri;
			if (!schemeFilter || resource.scheme === schemeFilter) {
				return resource;
			}
		}

		return undefined;
	}

	getLastActiveFile(filterByScheme: string): URI | undefined {
		for (const input of this.getHistory()) {
			let resource: URI | undefined;
			if (isEditorInput(input)) {
				resource = EditorResourceAccessor.getOriginalUri(input, { filterByScheme });
			} else {
				resource = input.resource;
			}

			if (resource?.scheme === filterByScheme) {
				return resource;
			}
		}

		return undefined;
	}

	//#endregion
}

registerSingleton(IHistoryService, HistoryService);