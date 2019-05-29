import contextMenuWidget from './context_menu.js';
import dragAndDropSetup from './drag_and_drop.js';
import messagingService from './messaging.js';
import noteDetailService from './note_detail.js';
import protectedSessionHolder from './protected_session_holder.js';
import treeUtils from './tree_utils.js';
import utils from './utils.js';
import server from './server.js';
import treeCache from './tree_cache.js';
import infoService from "./info.js";
import treeBuilder from "./tree_builder.js";
import treeKeyBindings from "./tree_keybindings.js";
import Branch from '../entities/branch.js';
import NoteShort from '../entities/note_short.js';
import hoistedNoteService from '../services/hoisted_note.js';
import confirmDialog from "../dialogs/confirm.js";
import optionsInit from "../services/options_init.js";
import TreeContextMenu from "./tree_context_menu.js";
import bundle from "./bundle.js";

const $tree = $("#tree");
const $createTopLevelNoteButton = $("#create-top-level-note-button");
const $collapseTreeButton = $("#collapse-tree-button");
const $scrollToActiveNoteButton = $("#scroll-to-active-note-button");

let setFrontendAsLoaded;
const frontendLoaded = new Promise(resolve => { setFrontendAsLoaded = resolve; });

// focused & not active node can happen during multiselection where the node is selected but not activated
// (its content is not displayed in the detail)
function getFocusedNode() {
    const tree = $tree.fancytree("getTree");

    return tree.getFocusNode();
}

// note that if you want to access data like noteId or isProtected, you need to go into "data" property
function getActiveNode() {
    return $tree.fancytree("getActiveNode");
}

async function getNodesByBranchId(branchId) {
    utils.assertArguments(branchId);

    const branch = await treeCache.getBranch(branchId);

    return getNodesByNoteId(branch.noteId).filter(node => node.data.branchId === branchId);
}

function getNodesByNoteId(noteId) {
    utils.assertArguments(noteId);

    const list = getTree().getNodesByRef(noteId);
    return list ? list : []; // if no nodes with this refKey are found, fancy tree returns null
}

async function setPrefix(branchId, prefix) {
    utils.assertArguments(branchId);

    const branch = await treeCache.getBranch(branchId);

    branch.prefix = prefix;

    for (const node of await getNodesByBranchId(branchId)) {
        await setNodeTitleWithPrefix(node);
    }
}

async function setNodeTitleWithPrefix(node) {
    const noteTitle = await treeUtils.getNoteTitle(node.data.noteId);
    const branch = await treeCache.getBranch(node.data.branchId);

    const prefix = branch.prefix;

    const title = (prefix ? (prefix + " - ") : "") + noteTitle;

    node.setTitle(utils.escapeHtml(title));
}

async function expandToNote(notePath, expandOpts) {
    return await getNodeFromPath(notePath, true, expandOpts);
}

function findChildNode(parentNode, childNoteId) {
    let foundChildNode = null;

    for (const childNode of parentNode.getChildren()) {
        if (childNode.data.noteId === childNoteId) {
            foundChildNode = childNode;
            break;
        }
    }
    return foundChildNode;
}

async function getNodeFromPath(notePath, expand = false, expandOpts = {}) {
    utils.assertArguments(notePath);

    const hoistedNoteId = await hoistedNoteService.getHoistedNoteId();
    let parentNode = null;

    for (const childNoteId of await getRunPath(notePath)) {
        if (childNoteId === hoistedNoteId) {
            // there must be exactly one node with given hoistedNoteId
            parentNode = getNodesByNoteId(childNoteId)[0];

            continue;
        }

        // we expand only after hoisted note since before then nodes are not actually present in the tree
        if (parentNode) {
            if (!parentNode.isLoaded()) {
                await parentNode.load();
            }

            if (expand) {
               parentNode.setExpanded(true, expandOpts);
            }

            let foundChildNode = findChildNode(parentNode, childNoteId);

            if (!foundChildNode) { // note might be recently created so we'll force reload and try again
                await parentNode.load(true);

                foundChildNode = findChildNode(parentNode, childNoteId);

                if (!foundChildNode) {
                    messagingService.logError(`Can't find node for child node of noteId=${childNoteId} for parent of noteId=${parentNode.data.noteId} and hoistedNoteId=${hoistedNoteId}, requested path is ${notePath}`);
                    return;
                }
            }

            parentNode = foundChildNode;
        }
    }

    return parentNode;
}

async function activateNote(notePath, noteLoadedListener) {
    utils.assertArguments(notePath);

    // notePath argument can contain only noteId which is not good when hoisted since
    // then we need to check the whole note path
    const runNotePath = await getRunPath(notePath);

    if (!runNotePath) {
        console.log("Cannot activate " + notePath);
        return;
    }

    const hoistedNoteId = await hoistedNoteService.getHoistedNoteId();

    if (hoistedNoteId !== 'root' && !runNotePath.includes(hoistedNoteId)) {
        if (!await confirmDialog.confirm("Requested note is outside of hoisted note subtree. Do you want to unhoist?")) {
            return;
        }

        // unhoist so we can activate the note
        await hoistedNoteService.unhoist();
    }

    if (glob.activeDialog) {
        glob.activeDialog.modal('hide');
    }

    const node = await expandToNote(notePath);

    if (noteLoadedListener) {
        noteDetailService.addDetailLoadedListener(node.data.noteId, noteLoadedListener);
    }

    // we use noFocus because when we reload the tree because of background changes
    // we don't want the reload event to steal focus from whatever was focused before
    await node.setActive(true, { noFocus: true });

    clearSelectedNodes();

    return node;
}

/**
 * Accepts notePath which might or might not be valid and returns an existing path as close to the original
 * notePath as possible.
 */
async function resolveNotePath(notePath) {
    const runPath = await getRunPath(notePath);

    return runPath ? runPath.join("/") : null;
}

/**
 * Accepts notePath and tries to resolve it. Part of the path might not be valid because of note moving (which causes
 * path change) or other corruption, in that case this will try to get some other valid path to the correct note.
 */
async function getRunPath(notePath) {
    utils.assertArguments(notePath);

    const path = notePath.split("/").reverse();

    if (!path.includes("root")) {
        path.push('root');
    }

    const hoistedNoteId = await hoistedNoteService.getHoistedNoteId();

    const effectivePath = [];
    let childNoteId = null;
    let i = 0;

    while (true) {
        if (i >= path.length) {
            break;
        }

        const parentNoteId = path[i++];

        if (childNoteId !== null) {
            const child = await treeCache.getNote(childNoteId);

            if (!child) {
                console.log("Can't find note " + childNoteId);
                return;
            }

            const parents = await child.getParentNotes();

            if (!parents) {
                messagingService.logError("No parents found for " + childNoteId);
                return;
            }

            if (!parents.some(p => p.noteId === parentNoteId)) {
                console.debug(utils.now(), "Did not find parent " + parentNoteId + " for child " + childNoteId);

                if (parents.length > 0) {
                    console.debug(utils.now(), "Available parents:", parents);

                    const someNotePath = await getSomeNotePath(parents[0]);

                    if (someNotePath) { // in case it's root the path may be empty
                        const pathToRoot = someNotePath.split("/").reverse();

                        for (const noteId of pathToRoot) {
                            effectivePath.push(noteId);
                        }

                        effectivePath.push('root');
                    }

                    break;
                }
                else {
                    messagingService.logError("No parents, can't activate node.");
                    return;
                }
            }
        }

        effectivePath.push(parentNoteId);
        childNoteId = parentNoteId;

        if (parentNoteId === hoistedNoteId) {
            break;
        }
    }

    return effectivePath.reverse();
}

async function getSomeNotePath(note) {
    utils.assertArguments(note);

    const path = [];

    let cur = note;

    while (cur.noteId !== 'root') {
        path.push(cur.noteId);

        const parents = await cur.getParentNotes();

        if (!parents.length) {
            infoService.throwError(`Can't find parents for note ${cur.noteId}`);
            return;
        }

        cur = parents[0];
    }

    return path.reverse().join('/');
}

async function setExpandedToServer(branchId, isExpanded) {
    utils.assertArguments(branchId);

    const expandedNum = isExpanded ? 1 : 0;

    await server.put('branches/' + branchId + '/expanded/' + expandedNum);
}

function getSelectedNodes(stopOnParents = false) {
    return getTree().getSelectedNodes(stopOnParents);
}

function clearSelectedNodes() {
    for (const selectedNode of getSelectedNodes()) {
        selectedNode.setSelected(false);
    }

    const currentNode = getActiveNode();

    if (currentNode) {
        currentNode.setSelected(true);
    }
}

async function treeInitialized() {
    if (noteDetailService.getTabContexts().length > 0) {
        // this is just tree reload - tabs are already in place
        return;
    }

    let openTabs = [];

    try {
        const options = await optionsInit.optionsReady;

        openTabs = JSON.parse(options.openTabs);
    }
    catch (e) {
        messagingService.logError("Cannot retrieve open tabs: " + e.stack);
    }

    const filteredTabs = [];

    for (const openTab of openTabs) {
        const noteId = treeUtils.getNoteIdFromNotePath(openTab.notePath);

        if (await treeCache.noteExists(noteId)) {
            // note doesn't exist so don't try to open tab for it
            filteredTabs.push(openTab);
        }
    }

    if (filteredTabs.length === 0) {
        filteredTabs.push({
            notePath: 'root',
            active: true
        });
    }

    if (!filteredTabs.find(tab => tab.active)) {
        filteredTabs[0].active = true;
    }

    for (const tab of filteredTabs) {
        await noteDetailService.loadNoteDetail(tab.notePath, {
            tabId: tab.tabId,
            newTab: true,
            activate: tab.active
        });
    }

    // previous opening triggered task to save tab changes but these are bogus changes (this is init)
    // so we'll cancel it
    noteDetailService.clearOpenTabsTask();

    setFrontendAsLoaded();
}

let ignoreNextActivationNoteId = null;

function initFancyTree(tree) {
    utils.assertArguments(tree);

    $tree.fancytree({
        autoScroll: true,
        keyboard: false, // we takover keyboard handling in the hotkeys plugin
        extensions: ["hotkeys", "dnd5", "clones"],
        source: tree,
        scrollParent: $tree,
        minExpandLevel: 2, // root can't be collapsed
        click: (event, data) => {
            const targetType = data.targetType;
            const node = data.node;

            if (targetType === 'title' || targetType === 'icon') {
                if (event.shiftKey) {
                    node.setSelected(!node.isSelected());
                }
                else if (event.ctrlKey) {
                    noteDetailService.loadNoteDetail(node.data.noteId, { newTab: true });
                }
                else {
                    node.setActive();
                    node.setSelected(true);

                    clearSelectedNodes();
                }

                return false;
            }
        },
        beforeActivate: (event, data) => {
            // this is for the case when tree reload has been called and we don't want to
            // FIXME: why do we have this in both beforeActivate and activate?
            // FIXME: also shouldn't we set ignoreNextActivationNoteId in any case? Otherwise subsequent activation of this note might be one-time ignored
            if (ignoreNextActivationNoteId && getActiveNode() !== null && getActiveNode().data.noteId === data.node.data.noteId) {
                ignoreNextActivationNoteId = null;
                return false;
            }
        },
        activate: async (event, data) => {
            const node = data.node;
            const noteId = node.data.noteId;

            if (ignoreNextActivationNoteId === noteId) {
                ignoreNextActivationNoteId = null;
                return;
            }

            // click event won't propagate so let's close context menu manually
            contextMenuWidget.hideContextMenu();

            const notePath = await treeUtils.getNotePath(node);

            noteDetailService.switchToNote(notePath);
        },
        expand: (event, data) => setExpandedToServer(data.node.data.branchId, true),
        collapse: (event, data) => setExpandedToServer(data.node.data.branchId, false),
        init: (event, data) => treeInitialized(), // don't collapse to short form
        hotkeys: {
            keydown: treeKeyBindings
        },
        dnd5: dragAndDropSetup,
        lazyLoad: function(event, data) {
            const noteId = data.node.data.noteId;

            data.result = treeCache.getNote(noteId).then(note => treeBuilder.prepareBranch(note));
        },
        clones: {
            highlightActiveClones: true
        },
        enhanceTitle: async function (event, data) {
            const node = data.node;
            const $span = $(node.span);

            if (node.data.noteId !== 'root'
                && node.data.noteId === await hoistedNoteService.getHoistedNoteId()
                && $span.find('.unhoist-button').length === 0) {

                const unhoistButton = $('<span>&nbsp; (<a class="unhoist-button">unhoist</a>)</span>');

                $span.append(unhoistButton);
            }

            const note = await treeCache.getNote(node.data.noteId);

            if (note.type === 'search' && $span.find('.refresh-search-button').length === 0) {
                const refreshSearchButton = $('<span>&nbsp; <span class="refresh-search-button jam jam-refresh" title="Refresh saved search results"></span></span>');

                $span.append(refreshSearchButton);
            }
        },
        // this is done to automatically lazy load all expanded search notes after tree load
        loadChildren: function(event, data) {
            data.node.visit(function(subNode){
                // Load all lazy/unloaded child nodes
                // (which will trigger `loadChildren` recursively)
                if( subNode.isUndefined() && subNode.isExpanded() ) {
                    subNode.load();
                }
            });
        }
    });

    $tree.on('contextmenu', '.fancytree-node', function(e) {
        const node = $.ui.fancytree.getNode(e);

        // right click resets selection to just this node
        // this is important when e.g. you right click on a note while having different note active
        // and then click on delete - obviously you want to delete only that one right-clicked
        node.setSelected(true);
        clearSelectedNodes();

        contextMenuWidget.initContextMenu(e, new TreeContextMenu(node));

        return false; // blocks default browser right click menu
    });
}

function getTree() {
    return $tree.fancytree('getTree');
}

async function reload() {
    const notes = await loadTree();

    // make sure the reload won't trigger reactivation. This is important especially in cases where we wait for the reload
    // to finish to then activate some other note. But since the activate() event is called asynchronously, it may be called
    // (or finished calling) after we switched to a different note.
    if (getActiveNode()) {
        ignoreNextActivationNoteId = getActiveNode().data.noteId;
    }

    await getTree().reload(notes);
}

function isNotePathInAddress() {
    const [notePath, tabId] = getHashValueFromAddress();

    return notePath.startsWith("root")
        // empty string is for empty/uninitialized tab
        || (notePath === '' && !!tabId);
}

function getHashValueFromAddress() {
    const str = document.location.hash ? document.location.hash.substr(1) : ""; // strip initial #

    return str.split("-");
}

async function loadTreeCache() {
    const resp = await server.get('tree');

    treeCache.load(resp.notes, resp.branches, resp.relations);
}

async function loadTree() {
    await loadTreeCache();

    return await treeBuilder.prepareTree();
}

async function collapseTree(node = null) {
    if (!node) {
        const hoistedNoteId = await hoistedNoteService.getHoistedNoteId();

        node = getNodesByNoteId(hoistedNoteId)[0];
    }

    node.setExpanded(false);

    node.visit(node => node.setExpanded(false));
}

async function scrollToActiveNote() {
    const activeContext = noteDetailService.getActiveTabContext();

    if (activeContext) {
        const node = await expandToNote(activeContext.notePath);

        node.makeVisible({scrollIntoView: true});

        node.setFocus();

        await activateNote(activeContext.notePath);
    }
}

function setBranchBackgroundBasedOnProtectedStatus(noteId) {
    getNodesByNoteId(noteId).map(node => node.toggleClass("protected", node.data.isProtected));
}

function setProtected(noteId, isProtected) {
    getNodesByNoteId(noteId).map(node => node.data.isProtected = isProtected);

    setBranchBackgroundBasedOnProtectedStatus(noteId);
}

async function setNoteTitle(noteId, title) {
    utils.assertArguments(noteId);

    const note = await treeCache.getNote(noteId);

    note.title = title;

    for (const clone of getNodesByNoteId(noteId)) {
        await setNodeTitleWithPrefix(clone);
    }
}

async function createNewTopLevelNote() {
    const hoistedNoteId = await hoistedNoteService.getHoistedNoteId();

    const rootNode = getNodesByNoteId(hoistedNoteId)[0];

    await createNote(rootNode, hoistedNoteId, "into");
}

async function createNote(node, parentNoteId, target, extraOptions = {}) {
    utils.assertArguments(node, parentNoteId, target);

    // if isProtected isn't available (user didn't enter password yet), then note is created as unencrypted
    // but this is quite weird since user doesn't see WHERE the note is being created so it shouldn't occur often
    if (!extraOptions.isProtected || !protectedSessionHolder.isProtectedSessionAvailable()) {
        extraOptions.isProtected = false;
    }

    if (noteDetailService.getActiveNoteType() !== 'text') {
        extraOptions.saveSelection = false;
    }
    else {
        // just disable this feature altogether - there's a problem that note containing image or table at the beginning
        // of the content will be auto-selected by CKEditor and then CTRL-P with no user interaction will automatically save
        // the selection - see https://github.com/ckeditor/ckeditor5/issues/1384
        extraOptions.saveSelection = false;
    }

    if (extraOptions.saveSelection) {
        [extraOptions.title, extraOptions.content] = parseSelectedHtml(window.cutToNote.getSelectedHtml());
    }

    const newNoteName = extraOptions.title || "new note";

    const {note, branch} = await server.post('notes/' + parentNoteId + '/children', {
        title: newNoteName,
        content: extraOptions.content,
        target: target,
        target_branchId: node.data.branchId,
        isProtected: extraOptions.isProtected,
        type: extraOptions.type
    });

    if (extraOptions.saveSelection) {
        // we remove the selection only after it was saved to server to make sure we don't lose anything
        window.cutToNote.removeSelection();
    }

    await noteDetailService.saveNotesIfChanged();

    noteDetailService.addDetailLoadedListener(note.noteId, noteDetailService.focusAndSelectTitle);

    const noteEntity = new NoteShort(treeCache, note);
    const branchEntity = new Branch(treeCache, branch);

    treeCache.add(noteEntity, branchEntity);

    let newNode = {
        title: newNoteName,
        noteId: branchEntity.noteId,
        parentNoteId: parentNoteId,
        refKey: branchEntity.noteId,
        branchId: branchEntity.branchId,
        isProtected: extraOptions.isProtected,
        extraClasses: await treeBuilder.getExtraClasses(noteEntity),
        icon: await treeBuilder.getIcon(noteEntity),
        folder: extraOptions.type === 'search',
        lazy: true
    };

    if (target === 'after') {
        await node.appendSibling(newNode).setActive(true);
    }
    else if (target === 'into') {
        if (!node.getChildren() && node.isFolder()) {
            await node.setExpanded();
        }

        node.addChildren(newNode);

        await node.getLastChild().setActive(true);

        const parentNoteEntity = await treeCache.getNote(node.data.noteId);

        node.folder = true;
        node.icon = await treeBuilder.getIcon(parentNoteEntity); // icon might change into folder
        node.renderTitle();
    }
    else {
        infoService.throwError("Unrecognized target: " + target);
    }

    clearSelectedNodes(); // to unmark previously active node

    // need to refresh because original doesn't have methods like .getParent()
    newNode = getNodesByNoteId(branchEntity.noteId)[0];

    // following for cycle will make sure that also clones of a parent are refreshed
    for (const newParentNode of getNodesByNoteId(parentNoteId)) {
        if (newParentNode.key === newNode.getParent().key) {
            // we've added a note into this one so no need to refresh
            continue;
        }

        await newParentNode.load(true); // force reload to show up new note

        await checkFolderStatus(newParentNode);
    }

    return {note, branch};
}

/* If first element is heading, parse it out and use it as a new heading. */
function parseSelectedHtml(selectedHtml) {
    const dom = $.parseHTML(selectedHtml);

    if (dom.length > 0 && dom[0].tagName && dom[0].tagName.match(/h[1-6]/i)) {
        const title = $(dom[0]).text();
        // remove the title from content (only first occurence)
        const content = selectedHtml.replace(dom[0].outerHTML, "");

        return [title, content];
    }
    else {
        return [null, selectedHtml];
    }
}

async function sortAlphabetically(noteId) {
    await server.put('notes/' + noteId + '/sort');

    await reload();
}

async function showTree() {
    const tree = await loadTree();

    initFancyTree(tree);
}

messagingService.subscribeToMessages(message => {
   if (message.type === 'refresh-tree') {
       reload();
   }
});

messagingService.subscribeToSyncMessages(syncData => {
    if (syncData.some(sync => sync.entityName === 'branches')
        || syncData.some(sync => sync.entityName === 'notes')) {

        console.log(utils.now(), "Reloading tree because of background changes");

        reload();
    }
});

utils.bindShortcut('ctrl+o', async () => {
    const node = getActiveNode();
    const parentNoteId = node.data.parentNoteId;
    const isProtected = await treeUtils.getParentProtectedStatus(node);

    if (node.data.noteId === 'root' || node.data.noteId === await hoistedNoteService.getHoistedNoteId()) {
        return;
    }

    await createNote(node, parentNoteId, 'after', {
        isProtected: isProtected,
        saveSelection: true
    });
});

async function createNoteInto() {
    const node = getActiveNode();

    await createNote(node, node.data.noteId, 'into', {
        isProtected: node.data.isProtected,
        saveSelection: true
    });
}

async function checkFolderStatus(node) {
    const children = node.getChildren();
    const note = await treeCache.getNote(node.data.noteId);

    if (!children || children.length === 0) {
        node.folder = false;
        node.icon = await treeBuilder.getIcon(note);
        node.renderTitle();
    }
    else if (children && children.length > 0) {
        node.folder = true;
        node.icon = await treeBuilder.getIcon(note);
        node.renderTitle();
    }
}

async function reloadNote(noteId) {
    await treeCache.reloadChildren(noteId);

    for (const node of getNodesByNoteId(noteId)) {
        await node.load(true);

        await checkFolderStatus(node);
    }
}

window.glob.createNoteInto = createNoteInto;

utils.bindShortcut('ctrl+p', createNoteInto);

utils.bindShortcut('ctrl+.', scrollToActiveNote);

$(window).bind('hashchange', async function() {
    if (isNotePathInAddress()) {
        const [notePath, tabId] = getHashValueFromAddress();

        console.debug(`Switching to ${notePath} on tab ${tabId} because of hash change`);

        noteDetailService.switchToTab(tabId, notePath);
    }
});

// fancytree doesn't support middle click so this is a way to support it
$tree.on('mousedown', '.fancytree-title', e => {
    if (e.which === 2) {
        const node = $.ui.fancytree.getNode(e);

        treeUtils.getNotePath(node).then(notePath => {
            if (notePath) {
                noteDetailService.openInTab(notePath);
            }
        });

        e.stopPropagation();
        e.preventDefault();
    }
});

utils.bindShortcut('alt+c', () => collapseTree()); // don't use shortened form since collapseTree() accepts argument
$collapseTreeButton.click(() => collapseTree());

$createTopLevelNoteButton.click(createNewTopLevelNote);
$scrollToActiveNoteButton.click(scrollToActiveNote);

frontendLoaded.then(bundle.executeStartupBundles);

export default {
    reload,
    collapseTree,
    setBranchBackgroundBasedOnProtectedStatus,
    setProtected,
    activateNote,
    getFocusedNode,
    getActiveNode,
    setNoteTitle,
    setPrefix,
    createNote,
    createNoteInto,
    getSelectedNodes,
    clearSelectedNodes,
    sortAlphabetically,
    showTree,
    loadTree,
    treeInitialized,
    setExpandedToServer,
    getNodesByNoteId,
    checkFolderStatus,
    reloadNote,
    loadTreeCache,
    expandToNote,
    getNodeFromPath,
    resolveNotePath,
    getSomeNotePath
};