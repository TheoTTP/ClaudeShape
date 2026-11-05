# Driving Onshape from inside its own web page

A field guide to the internals of Onshape's browser client (cad.onshape.com): how to read what the user has selected,
open and fill in dialogs, insert parts, make mates, send edits straight over Onshape's own websocket, read the 3D
viewer's geometry, draw inside the 3D view, drive undo, and run hidden second sessions. **Nothing here uses the REST API**
(no API keys, no OAuth); everything goes through the page's own JavaScript.

All of it was found by poking the live app between September and November 2026. Facts marked **(verified)** were seen
working on real Onshape. Facts with no mark were seen in code and comments but not called out as verified.

---

## 0. Ground rules

- **None of this is documented or supported by Onshape.** Onshape is a webpack bundle of minified code. Minified class
  and function names change with every release. These have stayed stable:
  - AngularJS service names (`SelectionService`…)
  - method names on Onshape's objects (`getActiveElementModel`, `updateSelectionList`…)
  - **message names** (`ui.GBTUiCommit`, `bsedit.GBTMParameterEnum`…)
  - CSS classes and `data-parameter-id` attributes in dialogs
  - toolbar command ids
  - `--os-*` CSS variables

  Find things **by name where a stable name exists, else by shape** (which methods and fields an object has, or a
  distinctive string in a module's source). Never rely on minified identifiers.
- **Onshape changes under you.** In October 2026 alone, the selection broadcast stopped firing for 3D clicks, the Insert
  dialog's number box became a new component, query chips lost their "×", and a tool's preview moved to a different
  data structure. When something that worked starts timing out, suspect an Onshape release first.
  - The release in use can be told from the script names: the main script is `/woolsthorpe.<hash>.js`, or use the sorted
    list of `/js/…js` names in `document.scripts`. Minified names only mean something within one build.
- **Be defensive.** Wrap every access in `try/catch` and optional chaining, test that a method is a function before
  calling it, and treat everything as "may be missing". Your code must never be able to break Onshape for the user.
- **Units:** everything inside the viewer and the selection data is in **metres** (transforms, bounds, polylines,
  camera). Dialogs show the document's units.
- **Realms:** objects from an iframe's window fail `instanceof` checks in the parent (Maps included). Test with
  `Object.prototype.toString.call(v) === "[object Map]"` or by duck typing.

---

## 1. Getting in

### 1.1 Run in the page's MAIN world

Onshape's objects live in the page's own JavaScript world. A Chrome extension's content script runs in an **isolated
world** and cannot see `window.angular`. You need code in the **MAIN world**: an MV3 content script entry with
`"world": "MAIN"`, or an injected `<script>`.

A clean split is two scripts:

- a small MAIN-world "bridge" that is the only code touching Onshape;
- an isolated-world script with your logic and UI, putting the UI in a Shadow DOM so Onshape's CSS doesn't reach it.

The two talk with `window.postMessage`. Keep the bridge inert, only listening, until told to start.

To reach frames too (Drawings, hidden sessions), use `all_frames` with `include_globs` in the manifest.

### 1.2 The AngularJS injector

```js
const injector = window.angular?.element(document).injector();
const svc = injector?.get("SelectionService");
injector?.has?.("SelectionService");   // probe without throwing
```

- `injector` is `undefined` until the app has booted: treat that as "Onshape hasn't finished loading". Poll, for example
  every 300 ms, and give up after ~90 s on pages that aren't the CAD app.
- A component's controller from its DOM element: `angular.element(el).data()`. The controller sits under a key such as
  `$ngControllerController`, `$osEnumParameterController`, `$osQuantityParameterController`,
  `$tabListItemController` or `$externalReferenceUpdateDialogController`. Also try `angular.element(el).scope()` and
  `.controller()`.
- **Walking scopes:** from `$rootScope`, use `$$childHead`, then each child's `$$nextSibling`. Cap the walk (8,000 scopes
  is plenty) and skip DOM nodes and typed arrays.

### 1.3 Webpack's `require`, for everything that isn't an Angular service

The chunk array is `window.webpackChunkNewton`. Get webpack's `require` the standard way:

```js
let req;
window.webpackChunkNewton.push([[Symbol("mine")], {}, (r) => { req = r; }]);
// req.m[id]  -> a module's factory; String(req.m[id]) gives its source
// req(id)    -> that module's exports (runs the factory if it hasn't run yet)
```

**Two rules. Breaking either has left users with a blank Onshape page:**

1. Push only once webpack's runtime has installed its own `push`: `Object.hasOwn(webpackChunkNewton, "push")`. Before
   that, the array is a plain one and your entry just sits in a queue.
2. Push only **after the Angular injector exists**. `req(id)` runs a module's factory if it hasn't run yet. Doing that
   while chunks are still arriving ran one of Onshape's serializer modules early. It threw and stayed half-built in
   webpack's cache, and Onshape's own startup then died with "Cannot read properties of undefined (reading 'Gf')" in
   serialize.js.

Cache `req` per window, because every push leaves a permanent record in the array. A reloaded frame has a new array, so
look again there.

**Finding a module by shape:** loop over `Object.keys(req.m)`, keep the factories whose `String(...)` contains a
distinctive string, `req(id)` them, and test the exports' shapes. Stringifying every module is expensive. Cache hits, and
retry a miss only after 1–3 s or once the module count has changed, because chunks keep loading.

Useful search strings:

| Source contains | Gives |
| --- | --- |
| `serializeMessageAndSendToServer` | the model connection class (§8.1) |
| `readMessage(){` + `"Unexpected message type"` | the binary message reader and, among its imports, the class table (§8.2) |
| `getMessageName(){return"<name>"}` | one message class by name |
| `getOpenDocumentController` | the open-document controller (§2.2) |
| `static getCommandToolbarModel(){` | the undo/redo toolbar model (§13) |
| a small module (< 2,000 chars) with `.on("all",` and `parameters:` | Onshape's event bus (§13) |
| `static createSelectionFromViewModels(` | the Insert dialog's insert item class (§6.6) |
| `canUseLocallyGeneratedThumbnails` (export with `prototype.getSelectedInsertableName`) | the Insert dialog row class |
| `static parseInsertableRestResponse(` | the custom-feature insertables parser (§4.3) |
| `parameterIdToParameter` + `buildConfigurationParameterFromBareValue` | the bare-value configuration map class (§6.1) |

### 1.4 Addresses and ids

```
/documents/<documentId>/w/<workspaceId>/e/<elementId>     a workspace (editable)
/documents/<documentId>/v/<versionId>/e/<elementId>       a version (read-only)
/documents/<documentId>/m/<microversionId>/e/<elementId>  a microversion
```

- An **element** is a tab: a Part Studio, Assembly, Drawing, Feature Studio and so on.
- Ids are 24 hex characters.
- A bare `/m/<microversion>` address bounces to the documents list.
- Onshape navigates between tabs and even documents **without a page load** (pushState). Re-read `location`, and re-find
  per-document objects like the connection; don't cache by page load. The Navigation API's `currententrychange` fires for
  these navigations, with `popstate` as a fallback.

Entity and feature ids use a base64 alphabet (`A–Z a–z 0–9 + /`):

| Id | Shape |
| --- | --- |
| Part Studio feature | starts with `F` |
| Assembly feature or mate | 17 characters starting with `M` |
| parameter `nodeId` | 16 characters |
| query `nodeId` | 15 characters starting with `F` |
| edit-session `requestId` | 16 characters |
| edges and faces | short deterministic ids such as `SWK9E`, `RYBV` |
| parts | short ids such as `RWKD` |

A Part Studio edit can renumber part ids (seen: `RhQL` → `RiQL`).

---

## 2. Services and controllers

### 2.1 Angular services

| Service | Use |
| --- | --- |
| `SelectionService` | Read and write the live selection (§3). Static `constructor.getCurrentSelections()` and `constructor.getSelectionListObservable()`; instance `updateSelectionList(oneSel)`, `clearSelectionList()`, `removeFromSelectionList(sel)`. |
| `ElementService` | `getActiveElementModel()` is the open tab's model (§4); `getCurrentElementCollection()` has one model per tab. |
| `ElementToolbarService` | `executeCommand(ns, cmd, details)`, `getSearchableTools()`, `createFsTools(owner, region, [tools])`, `currentElementId`, `getToolIds`, `getCustomToolsInNamespace("CREATE_FEATURE"\|"FS_FEATURE")`, `getToolPalette`, `getKnownFeaturesForElement`. |
| `MiniToolbarService` | `miniToolbarCollection[] = {tabType, commands:[{namespace, command, name}]}`. Names may start with `server:::`. Its `tabType`s list **every** tab kind in every tab, so don't use them to tell the tab type. |
| `AssemblyService` | Insert dialog control: `assemblyInsertModel`, `currentOpenAssemblyDialog`, `openInsertDialog(model, purpose)`, `closeAssemblyInsert()`, `closeFeatureDialogsAndNotifyOthers()`, `insertIntoAssembly(items, mode, extra)` (§6). |
| `StateService` | In-app navigation: `goToElement(elementId)`, `goToDocumentVersionElement(doc, version, element)` (~1 s, returns a promise), `isOnDocumentVersion()`. |
| `CompatibilityChecksService` | `.viewer` is the 3D viewer (§11). It's the same object the mate tool uses. |
| `KeyboardShortcutsService` | `keyboardShortcutsMap.getValue()` has one object per context (`"assembly"`, `"partStudio"`…) mapping a key combination to a command id. |
| `ThemeService` | `overrideTheme("dark"\|"light")` (session only), `getSessionTheme()`, `getUserTheme()`, `getThemeChangeObservable()`. |
| `ExternalReferenceService` | `startExternalReferenceUpdate()` / `stopExternalReferenceUpdate()` open and close the Reference manager (§15). |
| `DocumentResource` | `getInsertablesForVersion({...})`, the Insert dialog's listing of a document version (§6.7); `get({documentId}).name`. |
| `DocumentService` | `getLatestVersion(did)` returns `{id, name}`. **Since Nov 2026 it returns an observable, not a promise**: handle `subscribe({next, error})` and `then`. |
| `DocumentInsertableService` | `getInsertables(doc, "v", version, {includeFeatures})`, the custom-feature listing (§4.3). |
| `DocumentHistoryService` | `getMomentHistory(documentId, microversion)`, the history panel's request (§16). |
| `VersionsAndHistoryService` | `getGraphItemById(id)`. |
| `MessageBubbleService` | `showMessageWithAutoDismiss(message, …)` shows the red and green bubbles. Wrap it to catch Onshape's error text. |
| `$rootScope` | `$on(name, fn)`, `$broadcast`; Onshape's `command:*` events also go through the event bus (§13). |

### 2.2 Controllers you'll want

```js
const odc = openDocumentController();    // from the module containing "getOpenDocumentController"
const atc = odc.getActiveAssemblyDialogController().assemblyTreeController;   // Assembly tree (§10)
const flc = odc.getActiveFeatureListController();                              // Part Studio feature list (§14)
const mac = odc.getMeasurementAreaController();                                // Measure read-out
```

- `odc.getIsInEditableWorkspace()`, `odc.getOpenDocumentModel().get("canEdit")`
- `odc.updateUndoState(state)`, `odc.ignoreUndoRedoUpdates` (§13)
- **Measure read-out:** every selection change sends a `GBTUiMeasureCall`, answered after ~0.3 s and queued ahead of your
  later edits. To pause it during bulk selection work, override `mac.getCanUpdateMeasurements` to return false and call
  `mac.debouncedUpdateMeasurements.cancel()`.

---

## 3. Selection

### 3.1 Reading it

```js
const sels = injector.get("SelectionService").constructor.getCurrentSelections();   // static
```

**Change notification (changed Oct 2026, verified):** Onshape no longer broadcasts `SELECTION_UPDATED` on a click in
the 3D view. Subscribe to the static observable, which fires ~12 ms after the click:

```js
SelectionService.constructor.getSelectionListObservable().subscribe(() => setTimeout(onChange, 0));
```

Run your handler on the next task, because the list can be filled in just after. Keep a slow poll as a fallback. A cheap
"unchanged" check: a picked entity is a **new object** each time, so if every object in the list is identical (`===`) to
the last read, nothing changed.

A selection object's API:

- **Kind:** `isFace()`, `isEdge()`, `isVertex()`, `isMateConnector()`, `isUserSketchEntity()`, `isSketchFeature()`,
  `isBody()`, `isFeature()`
- **Geometry:** `isPlanarFace()` / `isPlane()`, `isCylinder()`, `isCone()`, `isSphere()`, `isTorus()`, `isLine()`,
  `isCircle()`, `isEllipse()`, `isSpline()`
- **Ids:** `getIdString()` (the entity id), `getDeterministicIdList()` / `getDeterministicId()`, `getPartId()`,
  `getFeatureId()` (null for part entities), `getFeatureType()`
- `getName()` — **for an edge it returns the part's name** ("Part 6"), not the edge's
- `getPickLocation()` returns canvas `[x, y]`
- `occurrence.path` is the Assembly instance path, an array of instance ids. The same hole on two copies of a part has
  the same entity id, so the path is what tells them apart.
- `entityMetaData` (or `getEntityMetaData()`):
  - `geometries[0]`:
    - `edgeType`: 1 = line, 3 = circle or arc
    - `isClosed`
    - `surfaceType`: 0 = plane
    - `surfaceParameters`: for a plane, `[0..2]` is a point, `[3..5]` a normal **that can point inward**, and `[6..8]` the
      x direction
    - `normals`: `[0..2]` is the **true outward normal** (verified)
    - `isPlanar`
  - `meshIncrement.points`: the tessellated polyline, a flat xyz array in metres in **part coordinates**. **There is no
    curve centre, axis or radius in the data**; fit the circle from the points. The points can arrive a moment after the
    selection. A mirrored edge's points run the other way. Some edges are stored as back-and-forth strips (`a,b,b,a` per
    segment).
  - `bodyMetaData {id, name, bounds {min, max} (metres, part coords), foundInPreview}`: the body's box.
  - `featureIds`
- `entityInferenceData`: the snap data Onshape attaches when a *person* picks with a tool active. It is **null for
  selections you create**, which matters for mate connectors (§7).

**The Part Studio origin** has two forms. Picked in the tree, `getFeatureType() === "origin"`. Clicked in 3D, it is a
vertex with `isFromPointBody()` and `entityMetaData.featureIds[0] === "Origin"`.

### 3.2 Writing it

- `SelectionService.updateSelectionList(sel)` takes **one selection object per call**. Passing an array throws
  (`getIdForCollection`).
- To clear, call `clearSelectionList()`. If the "remove all" variants throw without a list, remove items one at a time
  with `removeFromSelectionList(s)`.
- **Synthetic clicks on `canvas#canvas` do nothing.** Pick, or build the selection yourself.

**Ways to get a selection object:**

1. An Assembly instance: `ElementService.getActiveElementModel().getNodeModelFromPath(path).getSelection()`.
2. A named mate connector of an instance: see §7.2.
3. A pick: `viewer.pick(x, y, {})` returns hits. On one where `hit.isEntityPick()` is true, `hit.getModelSelection()`
   gives the selection (x and y in canvas CSS pixels).
4. **Hand-built, by entity id** (verified). Get the selection class from any existing selection's constructor, from a
   pick, or from `getActiveElementModel().getNodeModelFromNodeId("").getSelection().constructor`. Then:

   ```js
   new SelCls(0 /* entity type; 0 on every build seen */, entityId, occurrence /* null in a Part Studio */,
              { entityMetaData: meta, source: 0, usage: 0, featureIdList: [], name });
   ```

   Take `meta` from the viewer's `idToMetaData` (§11). `isEdge()` and `isCircle()` answer correctly, it highlights, and
   `updateSelectionList` accepts it like a click.

**Selections and dialogs:**

- A selection added **after** a tool's dialog opened goes into its **active** query field (verified).
- A selection that existed **before** the tool started is ignored by some tools (Mate connector) and taken as input by
  others: Replicate and Linear pattern take selected instances as seeds, and Standard content Insert mates onto selected
  holes. Clear first unless you mean it.
- A mate's edge target is read from the **remembered** selection, so select the edge first.
- Selection objects work across two same-origin pages: one copied from the parent page read back as the same entity in a
  frame.

---

## 4. The tab model

### 4.1 Active element model

```js
const m = injector.get("ElementService").getActiveElementModel();
m.isPartStudio(); m.isAssembly(); m.isDrawing();      // the reliable tab-type test (verified)
m.getElementId(); m.getMicroversionId();
m.attributes.microversionId.theId;                    // changes on every edit, undo and redo
m.attributes.elementId; m.attributes.isFeatureStudio;
```

### 4.2 Assembly model and tree nodes

The Assembly model works with no dialog open. It's the same object as an open dialog's `featureModel.nodeMap`.

**Lookups:**

- `getNodeModelFromNodeId("")` is the tree root. It's fully populated whether or not the tree panel is expanded
  (verified).
- `getNodeModelFromPath(path)`
- `getNodeModelFromFeatureId(id)`
- `getNodeModelFromFeatureIdAndPath(featureId, path)`, for a connector defined inside a part
- `getAllFeaturesOfTypes(["mate", "mateConnector", "replicate", "mateGroup"])` returns rows with `featureId`,
  `occurrence.path` (empty for the top level) and `.visible`

**Every node** has:

- `children`, `nodeId`, `id`, `parentId` (a mate's own connectors are its children)
- `name_` (empty for folders, so use `getName()`), `displayName_`. Instance names end in `" <n>"`.
- `documentId` and `elementId` on instances
- `featureType`: `""` = instance, `ASSEMBLY_FOLDER`, `mate`, `mateGroup`, `mateConnector`, `replicate`, `pattern`
- `visibility`: UNSET 0, HIDDEN 1, VISIBLE 2. Also `isParentHidden`.
- `suppressed`. **This flag can lag** behind the real state.
- `getSelection()`, `getOccurrence()`, `getOccurrenceWithNodeId()`, `getSelectedOccurrences()` (returns paths)

**Special nodes:**

- The root's fixed lists, `mateList` (the mates) and `loadList`, are also `ASSEMBLY_FOLDER`s. Recurse into folders;
  **a folder is not part of an occurrence path**.
- **Mate nodes:** `mateType` (a number: 1 Cylindrical, 2 Revolute, …), `selectedFeatures` (the two connector ids; a
  Part Studio connector is `<instance path>.<featureId>`), and `hasRegenError` (**0 fine, 3 error**) with
  `regenErrorMsg`. That's how to list broken mates (verified on real broken ones).
- **Group nodes** (`mateGroup`): members in `treeNode.occurrences` as dotted path strings.
- **Gear relations:** `iconName === "gear"`, with their two mates in `selectedFeatures`.
- **Replicate** nodes have their copies as children with `featureType ""`.

**Busy flag:** `atc.assemblyModel.get("isOperationInProgress")`. Wait while it's true.

### 4.3 Part Studio models

`ElementService.getCurrentElementCollection()` holds one model per tab.

- A Part Studio model has `featureIdToFeature`, a `Map` from feature id to feature, plus `featuresInitialized`.
- **The map is empty until that tab has been opened once in the page**, then it stays loaded even while another tab
  shows. `featuresInitialized` can turn true a moment before the features arrive. The map always holds the default origin
  and planes.
- The model's microversion is known even for a tab never opened.
- **Feature fields:** `featureType` (`"newSketch"`, `"importDerived"`, `"origin"`, `"defaultPlane"`, custom types),
  `name`, `suppressed`, `parameters[]` (`{parameterId, queries:[{deterministicIds}], namespace, …}`), and `entities` on
  sketches.
- A custom feature's `namespace` is `e…::m…` for the same document, or `d…::v…::e…::m…` for another.

---

## 5. Tools and the toolbar

### 5.1 Running tools

```js
const ets = injector.get("ElementToolbarService");
ets.executeCommand("START_ASSEMBLY_TOOL", "insertPartOrAssembly");   // Insert dialog
ets.executeCommand("START_ASSEMBLY_TOOL", "mate", "FASTENED");       // or "REVOLUTE", "CYLINDRICAL", …
ets.executeCommand("START_ASSEMBLY_TOOL", "replicate");
ets.executeCommand("START_ASSEMBLY_TOOL", "assemblyLinearPattern");
ets.executeCommand("START_ASSEMBLY_TOOL", "mateGroup");
ets.executeCommand("START_ASSEMBLY_TOOL", "mateRelation");           // Gear relation etc.
ets.executeCommand("CREATE_FEATURE", "mateConnector");               // Part Studio feature
```

- **No Angular service adds features.** Features are made either through their dialogs or by websocket messages (§8).
- **Custom FeatureScript tools:** `getSearchableTools()` returns entries `{namespace, command, commandDetails, name}`,
  as an array or an object. Run one with
  `executeCommand(tool.namespace || "CREATE_FEATURE", tool.command, tool.commandDetails)`, where
  `commandDetails = "d<doc>::v<version>::e<element>::m<microversion>"`.
- `"myFeature"` is FeatureScript's default command name and is shared by unrelated tools. Tell them apart by the
  Feature Studio (`::e<element>`).

### 5.2 Adding a custom FeatureScript tool to the user's toolbar

This is the "Add custom features" panel's own path (verified):

1. `DocumentInsertableService.getInsertables(docId, "v", versionId, {includeFeatures: true})` returns `{items}`.
2. Pass the items to the static `parseInsertableRestResponse(items)` on the class found in webpack (§1.3). Each entry's
   `children[].featureSpec` has `{namespace, featureType}`; pick the child you want.
3. `ElementToolbarService.createFsTools(0 /* owner: user */, 0 /* region: feature toolbar */, [child])`.

The tool is saved to the user's custom features and works at once, without a reload. Poll `getSearchableTools()` for up
to ~8 s to confirm. `addToCustomFeatureToolbar` looks right but only takes Onshape's own featured tools.

---

## 6. Feature dialogs (DOM)

### 6.1 Anatomy

- **Dialog and title:** `#feature-dialog`, title `.ns-dialog-title`.
- **OK:** `.ns-dialog-button-ok.button-ok`. It has `.disabled` until the feature is valid.
- **Cancel:** `.ns-dialog-button-cancel`.
- **Regeneration problem:** `.has-regen-error`. It flickers while some features compute, so wait for it to settle.
  Error bubbles contain text such as "did not regenerate", "failed to resolve" or "regeneration error".
- **Parameters:** every one is tagged `[data-parameter-id="<FeatureScript parameter id>"]`. Use that, not the labels.
- **Query fields:** `.os-param-query-list-container`.
  - Entries are `.os-param-query-list-entry-text`. **Since Oct 2026 newer chips draw no "×"**, so count entries rather
    than searching for "×".
  - An entry's delete control is `.os-param-selection-list-entry-delete`.
  - The active field has `.os-param-query-list-focus`.
  - **Activate a field with `.focus()` on its `.os-param-query-list`.** A click does nothing once the field holds a
    chip, and pressing an *empty* field moves focus on to the next field.
- **Dropdowns:** `div.select-container-wrapper > span.btn.form-control[aria-label="Select box activate"]`.
  - Press it. The list is drawn a moment later, possibly outside the dialog in `body > .os-select-container`; its items
    are `.os-select-choices-row-inner`. Press the innermost matching item.
  - Option ids often don't match labels, so choose by label.
  - A native `<select>`: set `value`, then dispatch `input` and `change`.
- **Number and quantity boxes:** `input.os-param-number`.
  - The Insert dialog's quantity used to be an AngularJS `os-quantity-parameter`. **Since Oct 2026** it is
    `.os-param-container[data-parameter-id]` containing `input.os-param-number`, with no Angular controller. Look for
    both.
- **Checkboxes:** `input.os-param-checkbox-input` with label `.os-param-checkbox-label`. `el.click()` toggles one even
  when it's hidden.
- **Flip arrows:** `osc-svg-icon[icon^="flip-direction"]` inside the parameter. The icon swaps between `flip-direction`
  and `flip-direction-opposite` when Onshape takes the press. On a busy page that took over 300 ms, so wait up to 1.5 s
  for the change before pressing again, or you flip it back.
  - Mate: `[data-parameter-id="primaryAxisAlignment"]`
  - Part Studio extrude-like features: `[data-parameter-id="oppositeDirection"]`
  - Linear pattern: `[data-parameter-id="flipPrimary"]`

### 6.2 Typing a value that sticks

1. Focus the box. If the page isn't focused (a background tab or pane), also dispatch `focus` and `focusin` yourself.
   Without them, after another field changed, the box dropped the value.
2. Set the value with the prototype's setter, so frameworks notice:
   `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "3.5 in")`.
3. Dispatch `new InputEvent("input", {bubbles: true, inputType: "insertText"})`, then `change`.
4. Blur. **Onshape commits on blur** (`ng-blur`). An unfocused page never fires `blur`, so dispatch `blur` and
   `focusout` yourself.
5. Read the value back. A value typed while Onshape is busy can come back as its old value, for example "0 in". Retype
   up to ~3 times.

**Never press Enter** in a feature dialog (it confirms the feature) and **never send Escape** (it may cancel the whole
dialog, even when you only meant to close a dropdown). Press the buttons.

### 6.3 Clicking

- Most controls react to a bubbling sequence of `pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click` at the
  element.
- Some lists, such as the Assembly instance list, need real `PointerEvent`s at the element's centre: `pointerId: 1`,
  `pointerType: "mouse"`, `isPrimary: true`, `button: 0`, and `clientX`/`clientY`.
- Dialog tabs (`.os-dialog-tab`, active one `active-tab`) take the same sequence.

### 6.4 Setting parameters through the model instead of the DOM

Find the dialog's feature model: walk scopes (§1.2) for one whose `featureModel.getFeatureType()` matches the feature.
A sketch is `"newSketch"` (or `"sketch"`). Then:

```js
const p = fm.getParameter("depth");      // hidden parameters too
p.availableOptions;                      // present on enums
p.setEnumValue("PLUS_Y");                // every parameter inherits it, so check availableOptions first
p.setQuantityExpression("0.25 in");      // a bare "0" is taken as "no value": send "0.0"
p.setEditableValueUsingDataString(v);    // other types; returns an error string on failure
p.getApiValueString();                   // read back: "0.25 in", "MateConnectorAxisType.PLUS_Y", ...
```

- Each change goes to Onshape and the preview follows.
- Lookup tables can only be set through their dropdowns.
- Some flags set in the model aren't sent: Linear pattern's `flipPrimary` has to be the arrow.

### 6.5 Opening an existing feature's Edit dialog (verified)

```js
const node = getActiveElementModel().getNodeModelFromFeatureId(featureId);
atc.createAndOpenFeatureDialog(node, 1);   // Assembly; 1 = BEGIN_EDIT, ~0.3 s
flc.createAndOpenFeatureDialog(node, 1);   // Part Studio (flc.getNodeModelFromFeatureId also exists); a sketch opens for editing
```

**Fallback:**

1. Select the tree row: `.ns-tree-root .os-list-item[data-id="<featureId>"]`, then press its `.os-list-item-label`.
2. Right-click it.
3. Press the `.context-menu-item-span` whose text is "Edit…".

The context menu has no "Edit…" while two things are selected. The instance and mate list is virtualised, so scroll to
a row with `atc.scrollToShowNode(nodeId)` first.

### 6.6 Driving a dialog out of sight

- **Hiding it:** a CSS rule with `opacity: 0 !important`, optionally plus `pointer-events: none`, on `#feature-dialog`,
  `#assembly-insert-dialog`, `.assembly-insert-dialog` and `body > .os-select-container`. Dropdown lists attach to
  `body`, outside the dialog. Dialogs keep working while invisible.
- **Holding the user's input** while you drive one: the mate tool re-aims at whatever the mouse hovers, which spoils an
  automated mate. Install capture-phase `window` listeners for pointer, mouse, wheel, touch and key events.
  - Swallow only trusted events (`e.isTrusted`), so your synthetic ones still pass.
  - Let through: Escape, wheel and right/middle drags on `#canvas` (zoom, orbit, pan), the view cube, and view keys when
    nothing is being typed into.
  - Let through any release whose press happened before the hold, or Onshape stays stuck panning.
  - Add a watchdog that lets go after ~2 minutes.

---

## 7. Inserting parts

### 7.1 Opening the Insert dialog restricted to one Part Studio (verified)

1. If `AssemblyService.assemblyInsertModel` is missing or belongs to another element (check
   `model.get("elementId")`), run `executeCommand("START_ASSEMBLY_TOOL", "insertPartOrAssembly")`. Poll every 40 ms,
   up to 5 s, until the model exists with the right `elementId`.
2. From that model, keep:
   - `model.constructor`
   - `model.get("assemblyModel")`
   - `model.get("elementConnection")`
   - `AssemblyService.currentOpenAssemblyDialog.dialogPurpose` (a number; 0 also works)
3. Close it with `AssemblyService.closeAssemblyInsert()`. This acts like ✓; cancelling shows "Assembly insertion has
   been cancelled".
4. **Wait** (up to 3 s, then 60 ms more) until `currentOpenAssemblyDialog` is falsy **and** `.assembly-insert-dialog`
   has left the DOM. Onshape mounts the list with a page-wide selector, so opening the next dialog while old markup
   remains leaves a dead copy of the list in the new one.
5. Call `AssemblyService.closeFeatureDialogsAndNotifyOthers()`.
6. Build and open the restricted model:

```js
const restricted = new Model({
  assemblyModel, elementConnection,
  restrictToDocumentId, restrictToVersionId, restrictToElementId,
  selectAssemblies: false,             // true to list Assemblies; a mismatch shows an empty list
  restrictToConfigurationMap: bareMap, // optional: opens already set to a configuration
});
AssemblyService.assemblyInsertModel = restricted;
AssemblyService.openInsertDialog(restricted, purpose);
```

- Build `bareMap` with the bare-value configuration map class (§1.3): `new Cls({parameterId: value, …})`.
- **Only pass a configuration map when every value is a string.** A boolean made the dialog fail with "Failed to load
  items for selection. t.toLowerCase is not a function".
- Don't pass a configuration map for an Assembly: the dialog becomes another kind with no Assemblies tab.
- Onshape drops its insert model whenever a dialog closes. The constructor, assembly model and connection learned earlier
  in the tab can be reused.

### 7.2 Rows and configuration fields

**Rows:**

- The row list is
  `angular.element(".assembly-insert-dialog .select-item-dialog-main-body").data().$ngControllerController.insertableSelector.getSortedElementInsertableViewModels()`.
  Match a row by `vm.insertable.element.elementId`.
- A row has `getIsSelectable()`, `getCanGenerateConfigurations()` and `generateConfigurations()`, plus the flags
  `retrieveConfiguredPartStudioRequested`, `isValidatingConfiguration`, `isLoadingConfiguration`,
  `isSettingConfigurationFromServer` and `hasConfigurationError`.
- **A row is listed while Onshape still loads it.** Pressing it before `getIsSelectable()` is true asks for nothing.
- A Generate pressed while Onshape is still validating a changed setting is silently dropped, and the row never becomes
  selectable. Call `generateConfigurations()` again.
- After Generate, the old row lingers until the build has run. Skip rows whose name still shows the old value.

**Configuration fields:**

- **Enums:** `.assembly-insert-dialog os-enum-parameter`, then
  `$osEnumParameterController.btParameter.parameterSpec`, which holds
  `{parameterId, parameterName, options (option ids), optionNames (labels)}`. Option ids are often not the labels: a
  1/8" option was `"Default"` and 1-1/8" was `"_1_125_"`.
- **Quantities:** the old `os-quantity-parameter` (controller `$osQuantityParameterController`), or the new
  `[data-parameter-id]` + `input.os-param-number` component.
- **Booleans:** `.os-param-container[data-parameter-id]` with `input.os-param-checkbox-input`.

### 7.3 Capturing `insertIntoAssembly`, and replaying it with no dialog (verified)

Pressing a row calls `AssemblyService.insertIntoAssembly(items, mode, extra)`:

- `items = [item]`. The item holds:
  - `insertable` (`documentId`, `documentVersionId`, `element.elementId`)
  - `configuration` (an array of parameter message objects)
  - `configurationKey`
  - `item`, the row view model, with `configuration` and `selectedParameters`
- `mode`: 0 = at the origin. The dialog's own mode makes the part follow the mouse; Standard content uses 7.
- `extra`: `[0]` for parts and Part Studios, `[0, 4]` for Assemblies.
- It returns a promise of `{insertedOccurrences: [{path}, …]}`. The new instance's path is the last entry.

**To capture:**

1. Replace `AssemblyService.insertIntoAssembly` with an own-property wrapper. Remember whether an own property already
   existed, so you can restore it or `delete` yours.
2. In the wrapper, store `items` and `extra`, then call the original with `(items, 0, extra)`.
3. **To capture without inserting**, return `Promise.resolve({insertedOccurrences: []})`. The dialog stays open with no
   bubble and closes normally with `closeAssemblyInsert()`.
4. Take the wrapper back afterwards, with a timeout. A one-shot wrapper let a late second press through into the wrong
   document.

**To replay**, call the original `insertIntoAssembly(items, 0, extra)` with a **fresh array**. No dialog opens: ~0.6 s
against ~1.9 s through the dialog.

- **Copies:** `[item, item, item, item]` inserted 4 instances in 187 ms, against 342 ms for four parallel calls. But see
  §7.5 about copies at unknown places.
- **Slow answers:** when the server is busy an insert can be answered after more than 15 s and still arrive. Retrying at
  15 s inserted twice, so wait about 60 s.
- **Refusals:** a refused insert resolves to nothing, and the reason only shows in a red bubble just after. Wrap
  `MessageBubbleService.showMessageWithAutoDismiss` (its message is a string or `{message}`) and read it ~50 ms after
  the promise settles.

### 7.4 Another configuration from a captured item (verified)

Copy each parameter with its prototype preserved, then change the value:

```js
const q = Object.assign(Object.create(Object.getPrototypeOf(p)), p, { value });
```

| Parameter | `value` |
| --- | --- |
| Enum | the option id |
| Boolean | `true` or `false` |
| Quantity | a number in `p.units` (for example `inch`), plus `expression: "3.5 in"` |

Plain-number parameters also carry `latestComputedValue.value`; keep it in step.

Then set `configurationKey: ""` on the item and on `item.item`, and replace `item.item.configuration` and
`selectedParameters` with the new array. Onshape works out the key itself and suffixes the instance name `<2>`
(cosmetic).

**Pitfalls:**

- **Option lists depend on earlier settings** (a bolt's Length list depends on its Head Type). Swapping an earlier
  setting and a later one together reused ids that weren't valid for the new combination, and **Onshape silently fell
  back to a default**: a 1" bolt came out 3/8". Change only the last setting, or check the new instance's `name_`.
- A Part Studio row inserted as a *whole Part Studio* brings its sketches too. Insert its part row instead.
- An Assembly's captured item carries a live, cyclic view model in `item` that its insert doesn't use.

### 7.5 Where the new instance lands, and inserting hidden

- **Placement:** the tree controller's `atc.updatePartsOffset(items)` returns each insert's `initialTransform`, normally
  a stacking offset. Wrap it to put the part exactly where you want (verified, 151 ms):

  ```js
  const mat = atc.convertToBTBSMatrix([0, 0, 0]);
  mat.updateFromGlMatrix(Float64Array.from(columnMajor4x4InMetres));
  return mat;
  ```

- **An Onshape bug to guard against:** after the first insert of an *Assembly* in a page, Onshape sets
  `atc.updateTranslation`. The next insert then runs `atc.updatePartTranslation`, which, with several edges selected,
  walks past the selection and throws "Cannot read properties of undefined (reading 'getInsertableName')". Every insert
  then fails, including the dialog's own. Wrap `updatePartTranslation` in try/catch; if `updatePartsOffset` throws, set
  `updateTranslation = false` and return the origin matrix.
- **Hidden inserts:** wrap `atc.elementConnection.callAndPromiseWithFeedback(message, …)` and set
  `message.isHidden = true` on the next outgoing message that has `insertables`. It goes out synchronously with the
  `updatePartsOffset` call, so treat a flag older than ~1 s as stale. Several dialog controllers can share one
  connection, so wrap it once. A hidden part's geometry never reaches the viewer, but it's solved and mated like any
  other.
- **Copies at unknown places:** copies of one part sent in one insert at the origin sometimes had a mate that was never
  solved (~1 run in 3); the mate was error-free but the part stayed at the origin. Send one insert per copy, or give
  each one its final place.
- **Clear the selection before a Standard content insert** (§7.6).
- **While an Insert dialog is open, Onshape refuses every delete** ("encountered a problem") and drops undo-list
  updates (§13).
- Every Insert dialog session leaves an **empty "Insert : " step** in history, even if nothing was inserted.

### 7.6 The Standard content tab (verified)

- **The tab:** the `.assembly-insert-dialog .os-dialog-tab` whose text is "Standard content". Press it with the event
  sequence from §6.3.
- **Its controller:**
  `angular.element(".assembly-insert-dialog .standard-content-container").data().$ngControllerController`. Its lists
  load a moment after the tab shows.
  - `selectionData.{selectedStandard, selectedCategory, selectedTypes, selectedType}`, with lists `standards`,
    `categories`, `types` and `componentType`.
  - Set a value to an exact list entry, call its handler (`onStandardChange`, `onCategoryChange`, `onTypesChange`,
    `onComponentChange`), then wait.
  - `componentData.parameters[] = {displayName ("Size", "Length", …), parameterId, parameterValues, defaultValue}`. Set
    `p.defaultValue = option` and call `userSelectParameterChange(p)`; Onshape solves (`solvePromise`) and **replaces**
    the parameters, so read them again. Lists depend on earlier choices (Length depends on Size).
  - It's settled when `!isContentLoading && !isComponentLoading` and `solvePromise` has resolved.
  - If `isAutoSizeOn`, auto size takes the size from the selected hole and disables Insert. Call `onAutoSizeToggle()`.
- **Inserting:** `doInsertInternal(0)` (0 = no stacking) makes the part (`StandardContentService.createContentForId`;
  the configuration is the *solved dimensions*, not the settings) and then calls
  `AssemblyService.insertIntoAssembly([item], 7, [0])`. That call can be captured and replayed like any other
  (0.24–0.37 s an insert).
- **Pitfall:** with hole edges selected, Insert inserts **and mates** a part on every hole by itself and never calls
  `insertIntoAssembly`. Clear the selection and wait until `hasInsertPreSelection` is false.
- Standard parts have a single connector, "Near". Each size is made on first use (~2 s).

### 7.7 Inserting without ever opening the dialog (verified on 58 of 58 library parts, 0.3–0.7 s)

**Step 1: list the source document version.** This is the Insert dialog's own browse request:

```js
DocumentResource.getInsertablesForVersion({ did, wv: "v", wvid,
  includeParts: true, includeAssemblies: true, includePartStudios: true /*, elementId, configuration */ })
// $q promise of { items: [...] }
```

- Rows have `id`, `parentId` (set on part rows under their Part Studio), `dataType` (`"onshape/partstudio"`,
  `"onshape/assembly"`), `elementId`, `elementName`, `partName`, and `configurationParameters` (base64 Onshape binary).
- Decode `configurationParameters` with the binary reader (§8.2):
  `new Reader(Uint8Array.from(atob(b64), c => c.charCodeAt(0))).readMessage().configurationParameters`. Entries:
  - **Enum:** `{parameterId, parameterName, enumName, namespace, defaultValue, options[{option, optionName}]}`
  - **Boolean:** `{parameterId, parameterName, defaultValue}`
  - **Quantity:** `{parameterId, parameterName, rangeAndDefault{defaultValue, minValue, maxValue, units, isInteger}}`
- Each parameter may carry a `visibilityCondition`, which decides which of several same-labelled parameters is shown:
  - `bsedit.GBTParameterVisibilityCondition`: always visible
  - `…VisibilityOnEqual {parameterId, value, inArray}`
  - `…VisibilityLogical {operation: 0 NOT / 1 AND / 2 OR, children}` (no children = never shown)
- One request lists a whole document (46 rows for 44 tabs). A part's name under a configured Part Studio needs one more
  request with `elementId` and a configuration.
- Listing a version also warms it (a first insert went from 600 to 176 ms), but not for sub-assemblies.

**Step 2: build or list the configuration.** Send what Generate sends, a **read** with no history step:

```js
const f = new GBTInsertablesFilter();               // "bsedit.GBTInsertablesFilter"
for (const k of ["includeParts", "includeSurfaces", "includeSketches", "includePartStudios", "includeMeshes",
  "includeFlattenedBodies", "includeCompositeParts", "includeSketchesOnFlat", "includeAssemblies"]) f[k] = true;
const q = Object.assign(new GBTUiQueryInsertablesForConfiguration(), {  // "ui.document.GBTUiQueryInsertablesForConfiguration"
  elementId: assemblyElementId, configuration: [/* parameter messages */],
  sourceDocumentId, sourceVersionId, sourceElementId, filter: f,
  documentMicroversionId: null, allowSameElement: false });
const answer = await connection.callAndPromise(q);  // { contents: [...], configurationKey }
```

- `configuration` holds one message per setting:
  - `bsedit.GBTMParameterEnum {parameterId, enumName, value: <option id>, namespace}`
  - `bsedit.GBTMParameterBoolean {parameterId, value}`
  - `bsedit.GBTMParameterQuantity {parameterId, units, value, expression: "3.5 in", isInteger}`
- **Send every enum and boolean**, at its default when not chosen. With none at all, a configured Part Studio lists none
  of its parts.
- `contents` rows are `…GBTUiInsertablePartStudio` (its parts in `children`), `…GBTUiInsertablePart` (`partName`),
  `…GBTUiInsertableAssembly` (`element.name`) and `…GBTUiInsertableFeatureGeometry` (sketches). Skip rows with
  `disableReason` set or `hasFaults` true.

**Step 3: make the insert item and insert.**

```js
const item = new ItemClass(row, configurationParams, answer.configurationKey,
                           undefined, undefined, undefined, false, false);
await AssemblyService.insertIntoAssembly([item], 0, [0]);   // [0, 4] for an Assembly
```

### 7.8 Keeping inserts across page loads

A captured insert item is a tree of message objects and a few UI objects. To save it:

- Tag each node with its message name (`__m` = `getMessageName()`) and its class name (`__c`), and drop `$$hashKey`.
- To rebuild a node, get its class from the message table by name (§8.2); for UI classes, from the live insert item and
  row classes. For entries under `configuration` and `selectedParameters`, use a live parameter of the same class.
- **Message names are stable across Onshape releases**, so an item saved under another build rebuilds fine when you go
  by message name.

### 7.9 Insert costs

- A configuration never built before costs **1.3–3.7 s**, and every edit queued behind it waits. Built configurations
  stay cached server-side for days, across documents.
- A read-only pre-build via §7.7 step 2 doesn't make the later Assembly insert cheaper. The insert builds its own.
- A part type's first insert in a session costs extra (e.g. 836 against 378 ms warm).

---

## 8. The modeling websocket: edits by message

### 8.1 Finding the connection

The page keeps one connection object per document ("bt.model.main"). Find it by shape:

1. Find the webpack module whose source contains `serializeMessageAndSendToServer`.
2. Among its exports, take the class with a static `getConnection` and a `prototype.writeToSocket`.
3. Among the same exports, take the enum object with a `MAIN` key.
4. `conn = cls.getConnection(enum.MAIN)`. Accept it only if `writeToSocket`, `call` and `send` are functions.

| Member | Purpose |
| --- | --- |
| `call(msg, cb)` | Request; `cb(response)` on the answer. On the wire it's `{callId, call: msg}`. |
| `callAndPromise(msg)` | Promise form of `call`. |
| `send(msg)` | One-way message, no answer. |
| `writeToSocket(msg)` | Everything goes through it. **Wrap it to record what Onshape's own UI sends**, the fastest way to learn any message. |
| `allSerializableMessagesObservable` | `.subscribe(m => …)`: every message, including **server → client** (`m.message ?? m`). |
| `getMessagesToServerObservable()` | A timeline of outgoing messages. |
| `getSocketState()` | `1` = open. |
| `getConnectionId()` | Truthy once the session is connected. |

- Assembly dialog and tree controllers also hold an `elementConnection` with `callAndPromise` and
  `callAndPromiseWithFeedback` (§10).
- Key the connection by document id and re-find it if Onshape moves to another document in the page.
- The object exists before its socket is open, and queries sent then get no answer. In a new frame, wait for
  `getSocketState() === 1`, a truthy `getConnectionId()` and an active element model, plus ~300 ms.
- Recording tips:
  - Keep-alive pings carry `lastLatencyMillis`; filter them out.
  - Each message caches its size in `_serializedByteLength`. **Reset it to 0 on any copy you send**, or the serializer
    uses a stale length.
  - `sourceParseTreeNodes`, `hasUserCode` and `libraryRelationType` are noise.
  - Bigints occur, so stringify them. Byte fields are `Uint8Array`.

### 8.2 Message classes

- Every message is an instance of a minified class whose prototype has `getMessageName()` (e.g. `"ui.GBTUiCommit"`) and
  `getClassId()`. The base class answers `"BTSerializableMessage"`.
- **One class by name:** search module sources for `getMessageName(){return"<name>"}`, then take the export whose
  `prototype.getMessageName()` equals the name (it may be a subclass exported in its place).
- **The whole table:**
  1. Find the module whose source contains `readMessage(){` and `"Unexpected message type"`; this is the binary reader.
  2. Among the modules it imports (source patterns like `x=y(<digits>)`), find one exporting a plain object that maps
     class id to class, with at least 200 entries, more than half of which are message classes.
  3. Build `name → class` from each entry's `prototype.getMessageName()`.

  In Oct 2026 this gave 3,387 classes: the most-derived UI subclasses, exactly the ones the page builds from what it
  receives.
- **The binary reader** is the export in that module whose prototype has `readMessage`:
  `new Reader(bytes).readMessage()`.
- **Making a message:** `new Cls()` and then assign fields, or `Object.create(Cls.prototype)` and copy fields in. Field
  names are plain, not minified; the serializer just needs the right prototype.
- **Saving messages as JSON:** a message becomes `{$m: name, $f: {fields}}`, a plain object `{$o: …}`, a `Uint8Array`
  `{$u8: […]}`, `undefined` `{$undef: 1}`. Rebuild with `Object.create(classByName.prototype)`, copy the fields and set
  `_serializedByteLength = 0`. Plain-object fields that occur include `sourceParseTreeNodes: {}`, `customData: {}` and
  `configurationParameterIdToValue: {}`.
- **Answers may contain Maps** with minified field names (an inference answer keeps its inferences in a Map keyed by
  entity id). Walk Maps and Sets as well as objects when searching an answer.
- To point a stored message at the current Assembly, set its **top-level** `elementId`. Nested `elementId`s may
  legitimately name other elements (a Part Studio).

### 8.3 How the server takes edits

- **One edit at a time per workspace, in order.** Every message has a fixed overhead (~48 ms or more, even a rename).
  - Redoing an entire 8 s build as one `GBTUiRedo` took **0.85 s**: ~90 % of a build's time is per-message overhead.
  - Cost grows with the number of instances **and** mates in the Assembly: at ~600 parts an edit costs 159 ms and an
    insert 326 ms. Hiding or suppressing instances doesn't reduce it; suppressing mates does.
- **Reads queue behind builds** in the same session. Inference requests waited ~1 s behind each configuration build,
  and queuing 16 builds made a 9 s job take 42–60 s.
- **An edit to a part Onshape is still evaluating can be silently dropped.** Put values (flip, offset) into the message
  that creates the thing rather than a later edit.
- **The answer to a read-only inference request means everything sent before it has been taken**, which makes a cheap
  "drain" barrier.
- A new mate reaches the Assembly model shortly after Onshape takes it. Poll
  `getActiveElementModel().getNodeModelFromNodeId(featureId)`.
- A new part's mate connectors appear in the model ~150 ms after its insert is answered.
- The server regenerates every earlier feature on each edit, so cost grows with the feature count.
- **Microversions and undo state:** each edit's undo state arrives ~20 ms *before* its new microversion. Commits in a
  queue are answered together, ~0.4 s after the last is taken.

### 8.4 Mates by message

Every top-level `ui.*` message has `elementId` (the Assembly's element id) and `messageId: ""`.

**What the mate dialog sends for one mate** (about 7 messages at ~0.15–0.2 s each):

1. `AddNode`: opens a draft
2. an outer edit session
3. rollback
4. an inner edit session
5. the first connector: add an existing one, or inference + create
6. the second connector the same way, then any parameter edits
7. close the inner session, commit, close the outer session

**Opening a draft mate.** `ui.assembly.GBTUiAssemblyAddNode`, sent with `send`:

```
{ elementId, messageId: "", editDescription: "Insert mate : Fastened", node }
node = assembly.GBTMMate {
  nodeId, featureId,                 // the same 17-char "M…" id
  featureType: "mate", name: "Fastened",
  parameters: [...], suppressed: false, namespace: "",
  suppressedParseNode, nameParseNode,  // tree.GBTNodeReference{nodeId: ""}
  subFeatures, returnAfterSubfeatures: false, suppressionState: null,
  parameterLibraries, version: 0, mateConnectors }
```

Its parameters, each with its own `nodeId`:

| parameterId | Class | Value |
| --- | --- | --- |
| `mateType` | `bsedit.GBTMParameterEnum` | `enumName: "Mate type"`, `"FASTENED"` / `"REVOLUTE"` / `"CYLINDRICAL"` / … |
| `mateConnectorsQuery` | `assembly.GBTMParameterQueryWithOccurrenceList` | `queries[]` |
| `mateOffsetEnabled` | `bsedit.GBTMParameterBoolean` | |
| `mateOffsetDistanceX` / `Y` / `Z` | `bsedit.GBTMParameterQuantity` | `{units: "inch", value, expression: "0 in", isInteger: false, latestComputedValue}` |
| `rotationType` | Enum | `enumName: "Rotation axis"`, `"ABOUT_X"` / `"ABOUT_Z"` |
| `rotation` | Quantity | `units: "degree"`, `"0 deg"` |
| `limitsEnabled` | Boolean | |
| `limitXMin` … `limitAxialZMax`, `limitEulerConeAngleMax` | `bsedit.GBTMParameterNullableQuantity` | `isNull: true`, `nullValue: "No minimum"` / `"No maximum"` |
| `functionalconnection` | Boolean | |
| `facestoconnect` | QueryList | |
| `primaryAxisAlignment` | Boolean | `true` = as made, `false` = flipped |
| `secondaryAxisAlignment` | Enum | `enumName: "Reorient secondary axis"`, `"PLUS_X"` |

- Quantities are in the units of the document the template came from; `expression` names the unit (`"0.2500 in"`,
  `"90.0000 deg"`).
- **Name:** send the kind alone, `name: "Fastened"`, and the server adds the number. A full name like `"Fastened 26"`
  comes out as `"Fastened 26 1"`. Onshape numbers a mate when its draft opens.
- Revolute and Cylindrical openings are identical apart from `mateType`. **If you keep a recorded opening as a template,
  make sure it's a Fastened one.** A Cylindrical learned as the template turned every later "Fastened" mate Cylindrical.

**Edit sessions.** `ui.assembly.GBTUiAssemblyItemSubscriptionRequest`, sent with `send`:
`{elementId, messageId: "", editDescription: "", requestId, itemType: 0, parentOccurrence: assembly.GBTOccurrence{path}, nodeId}`.
The dialog opens an outer and an inner one with `nodeId` = the feature id, and closes them with the same `requestId` and
`nodeId: ""`, inner first.

**Rollback.** `ui.GBTUiUpdateEditRollbackState {elementId, messageId: "", editRollbackState: 1}`, sent as a call.

**Adding an existing connector to the draft.** `ui.GBTUiSpecifyFeature`, sent as a call:

```
{ editDescription: "Add entity : Mate connectors", sequenceId: 0, featureNodeId: <mate id>,
  inContextEntitiesToAdd: null, selectionMicroversion: null, propagateChanges: false, propagationToSkip,
  featureChange: diff.GBTTreeEditInsertion {
    location: tree.GBTInsertionLocation { nodeId: <mateConnectorsQuery's nodeId>, before: false, childFieldIndex: 274432 },
    newNode: <connector query> } }
connector query = { nodeId, temporarySelectionName, path: [instance path], featureId: <connector feature id>, queryData: "" }
```

The query class depends on where the connector is defined:

- **In a Part Studio** (feature id starts with `F`): `assembly.GBTMPartStudioMateConnectorQuery`. A library part's
  connector id has dots in it, e.g. `…_0.*Auto0.opPattern.1.….merge.<id>_1`; use the *full* id.
- **In an Assembly**, such as a connector inside a sub-assembly (feature id starts with `M`):
  `assembly.GBTMFeatureQueryWithOccurrence`, same fields.
- The wrong class gives **"Mate cannot resolve mate connectors"** or a mate that holds nothing.

**Asking for an edge's inferred frame** (read-only). `ui.assembly.GBTUiGetCoordinateSystemInference`, sent as a call:

```
{ elementId, messageId: "", microversionId: document.GBTMicroversionId{theId: ""},
  occurrence: assembly.GBTOccurrence{path}, deterministicID: "<edge id>",
  selectionFilter: 0, pointPosition: math.GBTVector3d{0,0,0}, pointNormal: math.GBTVector3d{0,0,0},
  inContextAssemblyNodeId: null,
  microversionIdAndConfiguration: document.GBTMicroversionIdAndConfiguration{ microversion: {theId: ""}, configurationParameterIdToValue: {} },
  sequenceId: <n>, mateConnectorVersion: -1, featureScriptVersionNumber: 3096 }
```

- The answer holds coordinate systems `{origin: {x,y,z}, zAxis: {x,y,z}}`, usually as `coordinateSystem` next to
  `inferenceType` and `deterministicId`. They're in the **part's** coordinates, with Z along the face's **outward**
  normal.
- Pick `inferenceType === 3` (centre) with this edge's id. A circle's only inference is its centre.
- An id that names an instance rather than an edge returns **`error 9`**.

**Creating a mate connector from an inference.** `ui.assembly.GBTUiCreateMateConnector`, sent as a call:

```
{ elementId, messageId: "", editDescription: "Create mate connector", parameterId: "mateConnectorsQuery",
  inferenceQuery: assembly.GBTMInferenceQueryWithOccurrence {
    nodeId, temporarySelectionName, path, deterministicIds: [edgeId], entityQuery: "",
    secondDeterministicId: "", secondEntityQuery: "", inferenceType: 3 } }
```

- Inference types: **CENTER 3**, **MID_POINT 4**.
- The page also sends this message whenever a **person** makes a connector by hand, so a recorded one may be a midpoint
  snap carrying an entity query. Sent against another edge, that gives "Failed to resolve mate connector coordinate
  system". Always normalise it: type 3, the id only, empty second and entity fields.
- **It names no mate.** The server adds the connector to the draft opened **last**, so never interleave two mates'
  messages. Four interleaved mates made one mate; the same four sent one after another made four.
- It carries nothing from the inference answer, so the inference request and the create can go back to back.

**Parameter edit** (flip, offset…). `ui.GBTUiSpecifyFeature`:

```
{ editDescription: "Edit parameter : Flip primary axis", featureNodeId: <mate id>, sequenceId,
  featureChange: diff.GBTTreeEditChange {
    oldNode: tree.GBTNodeReference{nodeId: <param nodeId>},
    newNode: <the full parameter, same nodeId, new value (+ expression for quantities)> } }
```

**Commit.** `ui.GBTUiCommit {elementId, messageId: "", editDescription: "Insert feature : Fastened 3", featureNodeId, propertyNodeId: ""}`,
sent as a call.

**Cancel.** `ui.GBTUiCancel {elementId, messageId: "", featureNodeId: <draft id>}`, sent with `send`.

**Short form (verified, much faster):** put both connector queries straight into the opening message's
`mateConnectorsQuery.queries`, put flip and offset into its parameters, then send the commit. No sessions and no
rollback are needed. For a hole-edge target, send the inference request and the create right after the opening message.
28 such mates sent back to back were all confirmed in 1.9 s.

**Sequence numbers:** the page gives each mate a `sequenceId`. All inference requests of one mate share it, and the next
mate uses +1. That mate's parameter edits carried the number minus 2 (seen over 12 mates). Inference requests sent
together under one number got only the last one answered, so give standalone requests unique numbers.

### 8.5 A whole mate in one message: `ui.assembly.GBTUiCreateInferencedMate` (verified)

What Onshape's Standard content insert sends per hole. Sent as a call:

```js
const m = new GBTUiCreateInferencedMate();
m.elementId = assemblyId; m.editDescription = "Insert mate";
m.queries = [partConnectorQuery /* as above */, holeCentreQuery /* GBTMInferenceQueryWithOccurrence, type 3 */];
m.flipPrimary = false;     // same sense as primaryAxisAlignment
m.mateType = 6;            // 6 = FASTENED (0 is SLIDER)
m.addToModel = true;
// also has secondAxisAlignment, stackType
```

- The server builds the edge's connector itself.
- **There are no Offset or Rotation fields**, and no draft to edit afterwards.
- The new mate's id comes back only in the answer, `response.newMate.featureId`. `response.error`, or no `newMate`,
  means refused. Answers can take seconds on a cold server; only treat ~30 s of silence as a refusal.
- Two mates appeared in 139–148 ms, against 284–455 ms for the short form.

`ui.assembly.GBTUiCreateMultipleInferencedMates` is the multi version: one `insertOccurrences`
(a `GBTUiAssemblyInsertOccurrence`) plus a list of `GBTUiCreateInferencedMate`.

- **N insertables need N mates**: 1 + 27 or 2 + 4 did nothing, while 4 + 4, 8 + 8 and 16 + 16 worked.
- For Onshape's own standard parts the hole query alone is enough. **Library parts get empty mates unless each mate
  names both sides itself.**
- A mate in it can refer to any part, not only one inserted in that message.
- It's correct, and 16 inserts + 16 mates took 1.1 s, but in a real build it gave no measurable end-to-end gain, because
  the server pipelines separate messages anyway.

### 8.6 Replicate by message (verified: 6 copies in 0.67 s)

The opening is `ui.assembly.GBTUiAssemblyAddNode` with `editDescription: "Insert assembly replicate : Replicate"`:

```
node = assembly.GBTAssemblyReplicate { nodeId, customData: {}, version: 0, instanceControlNodes,
  replicateFeature: assembly.GBTMAssemblyReplicateFeature { featureType: "replicate", name: "Replicate", parameters } }
```

| parameterId | Kind | Values |
| --- | --- | --- |
| `seedInstances` | QueryList | |
| `seedMate` | QueryList | |
| `seedEntityType` | Enum ("Seed geometry type") | `"FACE"` / `"EDGE"` |
| `faceTargetType` | Enum ("Face match scope") | `"SAME_OCCURRENCE"` |
| `targetInstances`, `targetFeatures`, `targetFaces` | QueryList | |
| `edgeTargetType` | Enum ("Edge match scope") | `"SAME_FACE"`; `"SAME_EDGE"` = "Match individual edges" |
| `targetBoundingFaces`, `targetPlanes`, `targetEdges` | QueryList | |

- Edge targets are `assembly.GBTMIndividualQueryWithOccurrence {nodeId, temporarySelectionName, path, deterministicIds: [edgeId], entityQuery: ""}`.
- Seed instances are `assembly.GBTMIndividualOccurrenceQuery {nodeId, path}`, added with `GBTUiSpecifyFeature`
  ("Add entity : Instances") at the `seedInstances` nodeId.
- **What the server does:** it fills in `seedMate` itself, but only from *instance edits*, and only once that mate is
  solved. An opening that just holds the instances made a Replicate with **no copies**, and so did one sent right after
  its seed's mates. An explicit `seedMate` edit is undone by the instance edits after it.
- **What works when you know the seed's mate id:** put the instances, `seedEntityType: "EDGE"`,
  `edgeTargetType: "SAME_EDGE"`, the target edges and `seedMate` (a `GBTMFeatureQueryWithOccurrence` with
  `featureId` = the mate id and `path: []`) **all in the opening message**. Then send the session subscription,
  rollback, commit and session close, with no edits.
- The copies appear under the `replicate` node (look inside folders too) when the microversion arrives.
- A Replicate can't copy a part that is mated connector-to-connector, and its copies can't be put in a Group.
- **With Replicates in an Assembly, every later hole-edge mate costs ~3.5× more.** Make Replicates last.

### 8.7 Other messages

| Message | What it does |
| --- | --- |
| `ui.GBTUiFeatureSuppressionStatus {elementId, messageId: "", editDescription, nodeIds: [...], suppress, auxiliaryNodeIds: []}` | The tree's Suppress: many ids, one undo step. Suppressing an instance quiets its mates; suppressing or deleting a mate's own connector deletes the mate. |
| `ui.GBTUiUpdateUiState` (server → client) | `elementId`, `canUndo`, `canRedo`, `undoStrings`, `redoStrings` (§13). |
| `GBTUiUndo {undoSteps}` / `GBTUiRedo {redoSteps}` | Multi-step undo and redo in one message. |
| `ui.assembly.GBTUiBeginOperation` (`operationType` 0 = insert instances, a random `operationId`) … `GBTUiCommit {featureNodeId: operationId}` | Groups edits into one microversion and one undo step; 6–10 % cheaper. Onshape drops undo-list updates while an operation is open. |
| `ui.GBTUiBeginDelayedEdit` | Delayed regeneration. **Part Studio only**: an Assembly returns `GBTErrorMessage`. |
| `GBTUiAssemblyInsertOccurrence` | Fields: `insertables, startDrag, filterState, applyFilters, configuration, standardContentParametersId, isHidden, isSuppressed, initialTransform, elementLibraryReferenceData`. No parent folder. |
| `GBTUiPasteOccurrences` | `sourceOccurrences, sourceElementId, targetOccurrence, targetOption, translation`. A translation only, no rotation. Paste leaves out Replicate copies. |
| `GBTUiSolveFullAssembly` | Works only from a mate dialog a person opened. Sent bare it moves nothing. |
| `GBTUiMeasureCall` | Sent by the Measure read-out on every selection change. |
| `ui.collaboration.GBTUiClientList`, `GBTClientFunctionality` | Who is in the document (§17). |

**Don't do these; each broke something:**

- Don't send `GBTUniqueMatrixTransformOccurrences` by hand. It wedged the Assembly's server session.
- Don't add mates with `GBTUiAddFeatureCall` + `GBTTreeEditInsertion` in parallel. Calls sent before the page's model has
  the previous one overwrite each other, and a `GBTTreeEditList` is refused.
- Don't put an edge's inference query straight into a mate's opening message. It was slower and came out wrong.

---

## 9. Mates: the geometry rules

- **Implicit connectors:** Onshape's implicit connector at a hole edge points **the same way for both edges of a through
  hole**. To seat a part on the correct side, compare the part connector's world Z with the face's outward normal (the
  centre inference's Z) and flip if they disagree.
- **The outcome is predictable:** a plain Fastened mate by message, no flip, came out with the part connector's Z
  **opposite** the face normal (alignment −1) every time, so you can work out the result without waiting for a preview.
  The same message still came out the other way round in ~1 run of 7, so check afterwards.
- **Flip:**
  - Opening a mate already flipped (`primaryAxisAlignment: false`) is honoured for **Fastened** but **not Revolute**.
  - A later flip *edit* can be dropped while Onshape is still evaluating the part.
  - A flip pressed in the dialog that created the mate can be lost on ✓; pressed again in the Edit dialog once Onshape
    has settled, it holds.
- **Offset:** +Z moves the part along the edge connector's Z (the outward normal), and the other way once the mate is
  flipped (verified). Once mated, the Offset Z effectively runs along the face normal × the mate's alignment.
  - The Offset checkbox also reveals `rotationType` ("Rotate about X/Y/Z", default X) and `rotation`. "Rotate about Z"
    by 10° turned the part 10° right-handed about the connector's +Z without moving its origin.
  - A Revolute with an Offset of "Rotate about Z" is "Invalid rotation type." whatever the angle.
- **Rim connectors** (fastening a part by a circular rim):
  - Make the connector only **after** its inference is answered, or it comes out reversed.
  - Rim flips can't go by message, so insert the part already turned half round instead.
  - Send the named connector's query before the rim's inference.
- **Two mates on one part, back to back:** a Cylindrical sent right after a Revolute came out in the clicked edge's own
  frame, unturned, with **no error shown**. Put a drain (§8.3) between them.
- **Connectors made by hand via the Mate connector tool from code don't work:** a re-added edge has
  `entityInferenceData: null`, the connector comes out red, and a mate connector can't be put into another dialog's
  field. Use inferences instead.
- **Revolute angles and Gear relations:** a Revolute's angle is its first connector's instance turning about that
  connector's world Z. A Gear relation couples two Revolutes **from their zero positions**, with no offset. Not reversed,
  it turns mate 2 by −ratio × mate 1.
- **Never suppress the user's mates or Groups around your own edits.** Testing that for speed let the solver move the
  user's plates for good, and it gave no gain anyway.
- **Library updates can break mates** ("Mate cannot resolve mate connectors", "Failed to resolve the instance").

### 9.1 Driving the Mate dialog (verified)

1. Open it with `executeCommand("START_ASSEMBLY_TOOL", "mate", "FASTENED")`. It's ready when
   `#feature-dialog .ns-dialog-button-ok.button-ok` and `[data-parameter-id="mateConnectorsQuery"]` exist.
2. **Find the implicit mate connector controller:** walk scopes from `$rootScope`. It's at
   `scope.featureModel._listeners.<id>.listener.implicitMateConnectorController`; recognise it by an
   `onInferenceSelected` function and an `inferenceController` object. It also exposes `.viewer` and
   `.featureModel.nodeMap`.
3. **Put a part's named connector in the field:**
   - `nodeMap.getAllFeaturesOfTypes(["mateConnector"])`, keeping those whose `occurrence.path` equals the instance path;
   - `nodeMap.getNodeModelFromFeatureIdAndPath(featureId, path)`, matching `name_` or `getName()`;
   - `SelectionService.updateSelectionList(node.getSelection())`.

   A freshly inserted part's connectors appear a moment after the part.
4. **An implicit connector at a circular edge's centre:**

   ```js
   const ic = imc.inferenceController;
   ic.lockInferences = false;
   ic.setSelectionInferenced(null);
   ic.setSelectionInferenced(edgeSelection);
   ic.lockInferences = true;   // otherwise it follows the real mouse
   // poll ic.inferences for entries with deterministicId === edgeSelection.getIdString(); take inferenceType 3
   imc.onInferenceSelected(pick);  // then restore the lock
   ```

   `pick.coordinateSystem` is in the edge's part coordinates, with Z = the face's outward normal.
5. Flip with the `primaryAxisAlignment` arrow, and set the offset as in §9.
6. While a mate previews, the viewer already moves the instance: read
   `viewer.occurrenceDataManager.getOccurrenceData(id).transform` to judge it before pressing ✓.

### 9.2 Rough server costs (warm, small Assembly)

| Operation | Cost |
| --- | --- |
| Insert | 70–100 ms |
| Mate, connector to connector | ~95 ms |
| Mate to a hole edge | 130–160 ms |
| Rim mate | ~230 ms |
| Replicate | 150–200 ms |
| Group by message | ~0.3 s |
| One dialog step | ~0.15–0.2 s |

---

## 10. Replicate, Linear pattern, Group and Gear relation dialogs, and tree operations

### 10.1 The dialogs

**Replicate:**

1. **Clear the selection first.** The tool takes whatever is selected as instances.
2. Open it, then wait for the `seedInstances` field.
3. Add instances with `getNodeModelFromPath(path).getSelection()` and `updateSelectionList`.
4. **Onshape fills `seedMate` itself** when the instance has exactly one mate, and the offered mode switches from faces
   to edges.
   - A mate made moments ago may not be known for a second or two. Workaround: wait ~2.5 s, remove the instance chips,
     add them again, and wait.
5. Set `edgeTargetType` to "Match individual edges" through its dropdown.
6. Activate `targetEdges` and add the edges.
7. Wait for OK to be enabled with no regen error, then press ✓ (~0.8 s).

Replicate copies the mates between its seed instances and keeps offsets. Its copies can't be reached by path; find them
through the viewer's occurrence transforms. Don't press its first Instances field while it's empty.

**Linear pattern** (`assemblyLinearPattern`, feature type `pattern`):

1. Clear the selection.
2. Fill `seeds` with instances and `direction` with an edge.
3. Set `distance` (e.g. `"2 in"`) and `instanceCount` (the original included) through `featureModel.getParameter(id)`.
4. While the dialog is open, the copies are already instances under the new node, so read their transforms to see which
   way they went.
5. Press the `flipPrimary` arrow to reverse.

**Group** (`mateGroup`): activate `occurrencesQuery`, add each top-level instance, then press ✓. A Replicate's instance
is refused.

**Gear relation** (`mateRelation`): field `matesQuery`. A mate goes in **only by pressing its tree row** while the field
is active; its selection object doesn't take. Then fill `relationRatio` and the `reverseDirection` checkbox.

### 10.2 Tree controller operations

These are on `atc = odc.getActiveAssemblyDialogController().assemblyTreeController`:

| Call | Effect |
| --- | --- |
| `toggleVisibilityOnNodes(nodes, 2 \| 1)` | One edit for many nodes (3 instances in 73 ms). A Replicate's copies come out shown even with the seeds hidden, and hiding the Replicate node leaves them shown: toggle its children. |
| `createFeatureHideShowMsg(features, 1)` + `atc.elementConnection.callAndPromise(msg)` | "Hide mates and mate connectors". The tree's own `sendMessage` wants a feedback task, so use `callAndPromise`. |
| `deleteAssemblyTreeNodes(nodes)` | Same as the Delete key. A mate's node id is its feature id. |
| `createDeleteNodesMessage(...)` | A batch delete as one message. |
| `createRenameMessage({isDefaultFeature: false, elementId, featureId, nodeId, newName})` + `callAndPromise` | One message per rename. |
| `restructureAssembly(sources, target, 2)` | Move into a folder (AFTER 0, BEFORE 1, INTO 2). `target = folderNode.getOccurrenceWithNodeId()` (path `[folderNodeId]`; `getOccurrence()` gives an empty path and does nothing); `sources = instanceNode.getOccurrence()`. It asks the server about references first, so do one move at a time. **The reply is `null` whether or not it worked**; only a rejection means failure. |
| `createNewFolder(item)` | Calls `showFolderNameDialog()` (an observable of the typed name) and `getNodeIdsForNewFolder(item)` (normally the selection), then sends one restructure via `sendRestructureMessageInternal(msg)`. **To make folders with no UI**, temporarily replace `showFolderNameDialog` with something that emits the name synchronously and `getNodeIdsForNewFolder` with `() => ids`, then call `createNewFolder(null)`. Several can go back to back. |
| `scrollToShowNode(nodeId)` | The list is virtualised. |
| `createAndOpenFeatureDialog(node, 1)` | Edit dialog (§6.5). |
| `updatePartsOffset`, `updatePartTranslation`, `convertToBTBSMatrix` | Insert placement (§7.5). |

An instance's occurrence path stays `[instanceId]` inside a folder. There's no way to insert straight into a folder;
file the instance afterwards.

---

## 11. The 3D viewer

```js
const viewer = injector.get("CompatibilityChecksService").viewer;   // check it has getIdForOccurrencePath
viewer.gl;                 // WebGL2RenderingContext
viewer.el;                 // its canvas (also document.getElementById("canvas"))
viewer.printingInProgress; // true during print/thumbnail renders
```

**The tab or pane must be visible.** A hidden tab's viewer builds no geometry, Chrome freezes timers in hidden tabs, and
`viewer.bodyManager.occurrences` **empties while hidden**. Copy what you need from selections, which keep their own
`bodyMetaData`.

### 11.1 Model view managers and Part Studio data

- `viewer.modelViewManagers.modelViewManagers[0]` is the main view (note the doubled name). In a Part Studio, `[1]` is
  an open dialog's **preview**. `viewer.curvatureAnalysisManager.modelViewManager` also holds data.
- `main.partStudios["<elementId>-<microversion>"]`, optionally suffixed `(<configuration>)`, has one entry per Part
  Studio configuration in view. Entries share feature ids. After an edit, an older microversion's entry lingers, so
  prefer the key matching the current microversion. The drawing can lag the model's microversion.
- Each entry has `bodyComponent`, `sketchComponent`, `planeComponent`, `mateConnectorComponent` and `meshOwnerId`.

**`bodyComponent`:**

- **`idToMetaData`:** one entry per face, edge and vertex, with:
  - `bodyId`
  - `bodyMetaData {name, appearance, bounds, type, constituentBodyIds_}`. `type` 0 = solid; sketches, mate connectors
    and surfaces have other types. A composite part owns no entities itself: its edges sit on the solids in
    `constituentBodyIds_`.
  - `geometries[0]`, as in §3.1. A vertex has `point`.
  - `meshIncrement.points`, in metres in Part Studio coordinates. A line's points run a→b, b→a, so take the first point
    and the one farthest from it.
  - `isPreviewEntity` on preview entities.
- **`bodyMetaData[partId]`:** `{name, appearance: {color: [r,g,b] 0–255}, bounds}`.
- **`occurrences`:** keyed by viewer occurrence id (a Map or an object). Entries have `partIds[]`, `isHidden`,
  `fullElementId {documentId, elementId}` and `occurrenceData {occurrence: {path}, transform, isHidden}`. A path of
  length 1 is a top-level instance; 2 or more is inside a sub-assembly. In a Part Studio tab, `occurrences` holds one
  null entry, because parts aren't occurrences there.
- **Part Studio visibility:** `partStudioVisibility` (0 hidden, 1 shown). `isBodyVisible(partId)` throws in a frame.
  Skip `isFlattenedSheetMetalBody` and `isBendCenterLineBody`.
- **Per-face colours** (verified): `subBodyStyleOverrides.map[<bodyId>].map[<lod>].bufferSetRanges.map` maps each buffer
  set to runs `[start, end, style]` over its index buffer. In `style.attributeSettings.cachedKeyValues` (a flat key/value
  array), find the key whose `.name === "aVertexColor"`; the next element is `[r,g,b,a]`, as 0–1 or 0–255.

**`sketchComponent.idToMetaData`:** one entry per sketch entity, with `featureIds[0]` = the sketch, the same geometry
layout, and points in Part Studio coordinates. It includes construction geometry and hidden sketches. **An Assembly's
viewer draws no sketches.**

**`planeComponent.idToMetaData[id]`:** default and construction planes. `geometries[0].surfaceParameters` holds the
origin `[0..2]`, normal `[3..5]` and x direction `[6..8]`. The Front plane's normal is −Y.

**`mateConnectorComponent.idToMetaData`:** `featureIds[0]` (the connector feature) and
`coordinateSystem {origin, xAxis, zAxis}` (each `{x,y,z}`) in part coordinates. Names aren't here; get them from the
Assembly model (§9.1). Every configuration is its own entry with the same connector ids, so prefer the entry whose
`bodyComponent.occurrences` holds your instance.

**Implicit and Assembly-defined connectors:** `main.assemblies[<assemblyElementId>].mateConnectorData` (a Map or an
object). Entries have `implicit`, `entityIds[0]`, `occurrence.path` and `location {origin, xAxis, zAxis}` in that
occurrence's part coordinates.

**Dialog previews:**

- Classic form: `modelViewManagers[1].meshManager.groupRanges["<body>.<n>.<n>.<LOD>"] = {bounds: {min, max}}` in metres.
  It's null until measured, follows the flip arrow, and keeps the same body id.
- **Since Oct 2026** some tools' previews come instead as new entities in the preview manager's
  `partStudios[…].bodyComponent.idToMetaData`, tagged with `featureIds[0]` = the dialog's feature id. These can take ~3 s
  on a fresh page.
- The preview viewer **keeps the last preview's bodies after its dialog closes**, under the same ids.
- `viewer.bodyManager.previewOccurrences` stays empty, so it's useless as a signal.

### 11.2 Instances and transforms

- **Occurrence id:** `viewer.getIdForOccurrencePath(path)`. A part inside a sub-assembly is found only by the dotted
  string `"top.sub"`. −1 means unknown. **The viewer renumbers occurrences when parts are inserted**, so look ids up each
  time.
- `viewer.occurrenceIdManager.getNameForId(id)` gives the dotted path.
- **Transform:** `viewer.occurrenceDataManager.getOccurrenceData(id).transform` is the live placement, 16 numbers,
  **column-major** 4×4 (WebGL convention), metres:
  - rotation in `[0,1,2 / 4,5,6 / 8,9,10]`, translation in `[12,13,14]`;
  - `x' = m0·x + m4·y + m8·z + m12`, and so on;
  - local X, Y, Z axes are columns `[0..2]`, `[4..6]`, `[8..10]`;
  - it's rigid, so the inverse is the transposed rotation with translation −Rᵀt.

  `occurrenceDataManager.occurrenceData` holds them all.
- A part inside a sub-assembly is placed relative to it by `inverse(T_top) × T_part`.
- A part at the Assembly origin has the identity transform.
- A newly inserted part's geometry reaches the viewer a moment after the insert. **A hidden part's never does.**

### 11.3 Picking, projecting, unprojecting

- **Picking:** `viewer.pick(x, y, {})` (canvas CSS pixels) returns hits: `isEntityPick()`, `getModelSelection()`,
  `entityMetaData`, `occurrence`. Picking at an edge's `getPickLocation()` also returns the faces around it. A flat face
  is only picked from outside, so its normal there points out of the material (valid until the view is turned).
- **The world point under the cursor:** `viewer.retrieveCanvasLocationWorldPosition([x, y])` reads the depth buffer and
  returns the point on a part's surface, or **null over empty space**.
- **Unprojecting:** `viewer.getCamera().canvasToWorld([x, y, depth01])`. For empty space, use the window depth of a known
  point such as the origin.
- **Camera:** `viewer.getCamera()` gives `viewMatrix` and `projectionMatrix` (16 numbers each, column-major, metres) and
  `getViewport()` (device pixels). The camera is **orthographic** by default
  (`|P[15] − 1| < 1e-6 && |P[11]| < 1e-6`).
- **Projecting a world point to page pixels:**

  ```js
  const c = mul(P, mul(V, [x, y, z, 1]));          // behind the eye if c.w <= 0
  const px = ((c.x / c.w + 1) / 2) * cssWidth + rect.left;
  const py = ((1 - c.y / c.w) / 2) * cssHeight + rect.top;
  ```

  Mind the device pixel ratio; it was 1.75 in one setup.

### 11.4 Camera, resizing, the view cube

- **Resizing:** Onshape resizes its drawing buffer only when its own layout code calls `viewer.onResize()`. After
  changing the canvas or `.canvas-container` yourself, call it, about 30 ms later on a `setTimeout` (animation frames
  stop in background tabs).
- **Zoom to fit a box:** `viewer.animateZoomFit(box)`, with `box = new (viewer.getFitBounds()).constructor()` and
  `box.addPoint(...)`.
- **View cube:** `viewer.uiElements.find(e => e.id === "viewmanipulator")`. `center` is in viewport pixels from the
  **bottom left**; `topRightCorner` is its offset from the viewport corner; `isHidden`.
- **Asking for a frame:** `viewer.forceRequestDraw()`. Onshape only draws when something changes.
- If a new part isn't drawn, switching tabs away and back (or reloading) makes Onshape rebuild the view.

### 11.5 Hiding instances from view only

```js
viewer.bodyManager.occurrences.get(key).occurrenceData.setVisibility(0);   // 1 = shown; display only, no edit, no undo
```

- Selection outlines are separate: set `occurrenceData.baseHighlights` and `previewHighlights` to null, then call
  `damageBoundables()`.
- Onshape can rebuild a body at any time (a new LOD, a reload), so re-apply every ~250 ms. Restore only if
  `getOccurrenceData(id)` is still the same object.

### 11.6 Reading triangles out of the GPU (verified)

1. **Find the ranges.** `meshManager.groupRanges["<bodyId>.<meshOwnerId>.<primitive>.<LOD>"]`; primitive `4` is the
   triangles, LOD is `HIGH`, `MEDIUM` or `LOW`. `.bufferSetRanges.map` maps each buffer set to `[start, end)` index
   ranges, and a body can span several buffer sets.
2. **Check the buffers.** A buffer set has `vertexBuffer`, `indexBuffer` and `attributeBindings`. Each buffer has `.gl`,
   `.webGlBuffer` and `.initialCopyPerformed`; false means not uploaded yet. **CPU copies aren't kept**, so read the GPU.
3. **Read the indices.** They're uint32: bytes `[first*4, last*4)`.
4. **Read the vertices.** All positions come first (3 floats each, from `attributeBindings.aVertexPosition.offset`), then
   the normals (from `aVertexNormal.offset`). Read only the vertex range the triangles use.
5. **Read back with `getBufferSubData` on `COPY_READ_BUFFER`**, saving and restoring the binding:

   ```js
   const was = gl.getParameter(gl.COPY_READ_BUFFER_BINDING);
   gl.bindBuffer(gl.COPY_READ_BUFFER, buf.webGlBuffer);
   gl.getBufferSubData(gl.COPY_READ_BUFFER, byteOffset, outU8);
   gl.bindBuffer(gl.COPY_READ_BUFFER, was);
   ```

   Each read stalls the page briefly; read a few bodies per frame at most.
6. **The indices are triangle strips**, and repeated indices mark restarts. For each i, take `(a, b, c) = idx[i..i+2]`,
   skip it if two indices are equal, and swap to `(b, a, c)` on odd steps. Fix winding against the normals.
7. **Colours** come from `bodyMetaData[partId].appearance.color`, plus the per-face overrides (§11.1).
8. **Sanity-check** that the triangles fill `bodyMetaData.bounds`. Onshape's box can be ~25 % too large for some
   helical shapes.
9. **Sub-assemblies:** merge each part's mesh with `inverse(T_top) × T_part`.

### 11.7 Drawing inside Onshape's 3D view, with correct occlusion (verified)

- **The pass list:** `viewer.mainDrawPass.childPasses` is an array of passes, each with `preDraw`, `draw(ctx)` and
  sometimes `getEnabled()`. The scene draws first, straight into the canvas. Then comes a pass whose `preDraw` is **only**
  `gl.clear(gl.DEPTH_BUFFER_BIT)`, then the gadgets (view cube, triad, inferences). Right before that depth clear, the
  canvas holds the whole scene's depth.
- **Finding the depth-clear pass** by its source, skipping index 0:

  ```js
  const src = Function.prototype.toString.call(p.preDraw);
  /\.clear\(\s*[\w$]+\.DEPTH_BUFFER_BIT\s*\)/.test(src) && !src.includes("COLOR_BUFFER_BIT");
  ```

- **Hooking it:** replace that pass's `draw` with a wrapper that draws your geometry, then calls the original. Note
  whether `draw` was an own property (`Object.hasOwn`); to unhook, restore it or `delete` it. Onshape rebuilds its passes
  when the render mode changes, so re-check the hook every ~400 ms.
- **Skip a frame** when `gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) !== null` (an offscreen target is bound), when
  `pass.getEnabled()` returns false, or during `printingInProgress`.
- **Save and restore every piece of GL state you touch.** Onshape caches its own state:
  - `CURRENT_PROGRAM`, `VERTEX_ARRAY_BINDING`, `ARRAY_BUFFER_BINDING`, `COPY_READ_BUFFER_BINDING`
  - depth test, `DEPTH_FUNC`, `DEPTH_WRITEMASK`
  - blend enable, the four blend funcs and the two equations
  - cull face, polygon offset fill with factor and units
  - stencil test, `COLOR_WRITEMASK`, sample alpha to coverage

  Build your programs once per context (a `WeakMap<gl, …>`), and detach and delete shaders after linking.
- **Depth:** standard depth, cleared to 1; the canvas has `preserveDrawingBuffer: true`.
- **Clipping:** Onshape fits the near and far planes tightly to the document's parts, so foreign geometry gets clipped.
  Clamp clip-space z in your vertex shader and write `gl_FragDepth` yourself. That disables GL's polygon offset, so add
  it by hand: `factor × max(|dFdx z|, |dFdy z|) + units × 2^-depthBits`.
- **Fallback:** a `position: fixed` canvas over `viewer.el`'s rect, sized × `devicePixelRatio`. **Release its context
  with `WEBGL_lose_context` when done.** Chrome keeps only a handful of WebGL contexts and drops the oldest, which can be
  Onshape's.

---

## 12. Scanning an Assembly

Putting it together to get every instance, its placement, its box and its round holes:

1. Walk `getNodeModelFromNodeId("")` recursively, through folders. Instances are nodes with `featureType ""` and have
   `id`, `name_`, `documentId`, `elementId` and `suppressed`.
2. For each instance, `getOccurrenceData(getIdForOccurrencePath([id])).transform`.
3. For each Part Studio in `main.partStudios`, take the `bodyComponent.occurrences` that aren't hidden. Each part gives a
   box (`bounds`, part coordinates) and closed circles from `idToMetaData` (`edgeType 3`, `isClosed`). Fit each circle
   from its points and transform it into Assembly coordinates. Prefer the live `getOccurrenceData` transform.
4. For mates, read `getAllFeaturesOfTypes(["mate"])` and each node's `selectedFeatures`, `mateType` and `hasRegenError`.
5. Polyline arrays are replaced when a mesh changes, so cache per-edge results in a `WeakMap` keyed by the array.

---

## 13. Undo and redo

- **Undo lists are per session.** Edits from another tab or a hidden frame never appear in this page's list, though they
  show in the view.
- **The lists:**
  - The toolbar model is `Cls.getCommandToolbarModel()` (module containing `static getCommandToolbarModel(){`). It holds
    `{undoStrings, redoStrings, canUndo}`, newest first, up to 50 entries, labelled like "Insert : …" or
    "Update version : V82".
  - The authoritative copy comes from the server as `ui.GBTUiUpdateUiState`, which you can watch on
    `allSerializableMessagesObservable`. **Read the server's latest one rather than the toolbar's**, which can be stale.
- **Undoing and redoing N steps:** Onshape's event bus (the small module from §1.3; its export returns an object with
  `trigger` and `listenTo`):

  ```js
  bus.trigger("command:undoChanges", n);   // one GBTUiUndo with undoSteps = n (what the undo dropdown does)
  bus.trigger("command:redoChanges", n);   // one GBTUiRedo with redoSteps = n
  ```

  Any new edit empties the redo list, including the empty "Insert : " step an Insert dialog leaves.
- **Tracking:** every edit, undo and redo changes `getActiveElementModel().attributes.microversionId.theId`. To see an
  undo land, poll (every 100 ms, up to ~8 s) for the undo list, the redo list or the microversion to change. Watch all
  three, because undoing the entire history can leave the toolbar list looking unchanged.
- **Quirks:**
  - **While any feature or mate dialog is open**, Onshape sends a second, empty state ("nothing to undo") right after
    each real one. If it's the last of a run, the button stays grey though the server still has history. Put it back
    with `odc.updateUndoState(lastRealState)`, but only when `odc.ignoreUndoRedoUpdates !== true` and no dialog is open.
  - **While an Insert dialog is open, Onshape ignores undo updates** (`ignoreUndoRedoUpdates`). Afterwards it restores
    only whether undo is possible, **never the list**. Undoing by the toolbar's list after a long automated run went 40
    steps blind.
  - **Restore from Versions and history** empties the list for real: the new microversion, then an empty
    `GBTUiUpdateUiState` ~8 ms later. A restore can bring back an old microversion id. You can tell it from the dialog
    case because the microversion moved and no dialog is open.
  - Opening a version or switching workspace also clears the list.
  - `canUndo` false with an empty undo list but a non-empty `redoStrings` is a real state: you've undone everything.
- **Intercepting Ctrl+Z:** Onshape handles undo keys on `keydown`. A capture-phase `keydown` listener on `window`,
  installed at `document_start`, runs first and can `preventDefault()` + `stopImmediatePropagation()`. Redo keys are
  Ctrl+Y, Ctrl+Shift+Z, ⌘⇧Z and ⌘Y. Match `event.key` (the letter typed), not `event.code`, so AZERTY works. If your own
  edits are still in flight, hold a Ctrl+Z rather than passing it through, or it undoes the user's last edit instead.

---

## 14. Part Studios and sketches

- **Sketches:** features in `featureIdToFeature` (once the tab has been opened in the page) and drawings in the viewer's
  `sketchComponent`.
  - A sketch's plane: the `sketchPlane` parameter's `queries[0].deterministicIds[0]`, looked up in `planeComponent`
    (default planes) or as a face in `bodyComponent`.
  - Rebuilding circles without a drawing (a hidden sketch or a hidden frame): `feature.entities[].geometry.{radius, xCenter, yCenter}`
    in metres in sketch 2D coordinates (an entity with `startParam` is an arc), combined with the plane frame.
- **Derived sketches** (`importDerived`): the feature holds no entities; they exist only in the viewer's sketch drawing.
  Each has `featureIds = [<derive id>, "<derive id>.derived.*derived0.merge.<source sketch id>.--derived.*Auto0.-"]`. The
  feature's `partStudio` parameter `namespace` names the source (`d…::v…::e…::m…`).
- **Rollback bar** (`flc = odc.getActiveFeatureListController()`):
  - Nodes: `flc.partStudioElementModel.mapNodes(n => n.get("nodeId"), …)`; the bar is
    `model.getRollbackBarNodeId()`.
  - Move it with `const msg = flc.getRollEditMessage(node)` (after `node`; no argument = to the end), then
    `flc.elementConnection.callAndPromise(msg)`.
  - Set `msg.treeEdit.destination.before = true` to go before the first real feature. "After Right" (after a default
    plane) is refused. No message comes back while a feature is being edited.
- **Is a sketch open?** A scope's `featureModel.getFeatureType()` is `"newSketch"`. A sketch is a `#feature-dialog`
  too, so it blocks "no dialog open" checks.
- Delayed regeneration exists only in Part Studios. Selections built by entity id (§3.2) use a null occurrence here.

---

## 15. Linked documents (the Reference manager)

- **Tab flags:** `angular.element(tabEl).data().$tabListItemController.tab` gives `getIsActive()`, `getIsBehind()` (a
  linked document has a newer version), `getChildrenBehind()` and `getIsOutOfSync()`. A tab bar with no `tab-list-item`
  reads as "not behind", so don't trust that case.
- **Editability:** `StateService.isOnDocumentVersion()`, `odc.getIsInEditableWorkspace()`,
  `odc.getOpenDocumentModel().get("canEdit")`.
- **Opening the manager:** `ExternalReferenceService.startExternalReferenceUpdate()` (what "Update linked documents"
  does); close it with `stopExternalReferenceUpdate()`.
  - Its element is `external-reference-update-dialog`; the scope is
    `angular.element(el).data().$externalReferenceUpdateDialogController.$scope`.
  - Wait for `scope.documentVersionList.getIsLoaded()`.
  - Lines are in `outOfDateUpdateItems[]` / `allUpdateItems[]`, with `documentName`, `fromItemState`, `latestItemState`
    (`getVersionId()`), `hasWritePermission`, `isChildrenOutOfDate`, `isSelectiveUpdatable`, `isOutOfDate`,
    `isSelected` and `selectedItemState` (already the newest).
  - `list.canUpdateAll()` says whether Update all is enabled.
- **Update all:** `scope.$apply(() => scope.doUpdate(scope.UPDATE_TO_LATEST /* 0 */))`.
  - **In an Assembly it is recursive** (`linkedItemSet.canUpdatingAllRecursively` → `$rootScope` event
    `command:updateAllExternalReferences`). For a library you can't edit, it opens **"Select a workspace to update"**
    (Create workspace / Select workspace), so unattended it hangs.
  - Elsewhere it's one change message.
- **Selective update** (safe in Assemblies): set `isSelected = false` on every line and `true` on the one you want, then
  `scope.doUpdate(scope.SELECTIVE_UPDATE /* 1 */)`. That's one change and one undo step ("Update version : V82"), ~1 s,
  with mates re-solving 1–2 s later.
  - **Check the mates afterwards.** A library update broke two mates; one undo step takes it back.
  - Lines whose insides alone are behind, or with `isSelectiveUpdatable` false, need the library owner to update.

---

## 16. Versions and history

- **Panel controller:** `angular.element(document.querySelector(".model-flyout-versions-history")).data("$ngControllerController")`.
  - `getDisplayedGraphItems()` returns rows
    `{type: "workspace" | "version" | "Change" | "Separator", id, microversion, parent, documentId, name}`.
  - Rows off screen: `VersionsAndHistoryService.getGraphItemById(id)`. In the DOM a row is `#graphItem-<id>`.
  - The name column is `nowrap` + ellipsis.
- **History:** `DocumentHistoryService.getMomentHistory(documentId, microversion)` returns 50 entries a page, newest
  first, with `description`, `microversionId` and `nextMicroversionId` (sometimes with a trailing `_`).
  - A page takes 0.2–0.4 s, and one version's pages must be read in sequence (each names where the next starts).
    Different versions can be read in parallel: six at once took 50 versions from ~25 s to ~9 s.
  - **Don't use a row's own `historyList`**: it redirects the page away on an error.
- **Opening a version:** `/documents/<d>/v/<versionId>/e/<element>`, or in-app with
  `StateService.goToDocumentVersionElement(doc, version, element)` (~1 s, against 5–8 s to boot a fresh frame). If the
  tab doesn't exist in that version, Onshape opens another tab: check the model's id.
- **What's displayed:** `modelViewManagers[0].displayedElementMicroversionIdAndConfiguration.microversion.theId`, valid
  while `viewer.elementLoadState === 4`.
  - After switching versions the view empties (state 0) and comes back at state 4.
  - **For a moment both still name the previous version**, so wait for the view to empty and refill.
  - If the tab is identical between versions it may never reload; allow a few seconds' fallback.
- **Restore** behaviour: see §13.

---

## 17. Hidden frames: second sessions

A same-origin `<iframe>` of a document address boots a complete second Onshape client, with its own websocket
connection, undo list and viewer. Use one for background reads (other tabs' sketches, other versions, configuration
builds) or as a worker that makes edits away from the user's window. Its edits show in the main window as they land.

### 17.1 Opening and reaching it

```js
const f = document.createElement("iframe");
f.setAttribute("aria-hidden", "true"); f.tabIndex = -1; f.inert = true;
f.style.cssText = "position:fixed;left:0;top:0;width:1200px;height:800px;opacity:0;z-index:-1;pointer-events:none;border:0";
f.src = location.origin + "/documents/<d>/w/<w>/e/<element>";
document.body.appendChild(f);
const svc = (n) => f.contentWindow.angular?.element(f.contentWindow.document).injector()?.get(n);
```

- **Lay it out at full size and draw it at opacity 0.** With `display: none` its viewer uploads no triangles.
  Off-screen (`left: -4000px`) is fine if you only need features and placements.
- To close it, set `src = "about:blank"`, then `remove()`.
- **Moving it to another tab or version:** `svc("StateService").goToElement(elementId)` or `goToDocumentVersionElement`,
  then poll until `f.contentWindow.location.pathname` contains `/e/<element>`. Reusing one frame beat a frame per tab
  (8 Part Studios in 13.2 s against 17.9 s).
- **Choosing the start tab:** for a light session, open a Feature Studio tab, else a Part Studio.
- **Timings:** booting takes 2–8 s; parts can stream in until ~9 s; a version's tree and placements are ready in ~2 s.

### 17.2 Knowing it's loaded

- **Features:** the element collection's model has `featuresInitialized && featureIdToFeature.size > 0`. Allow ~0.5 s
  more, and up to ~6 s for planes on part faces.
- **Viewer:** `viewer.elementLoadState === 4 && !viewer.hasPendingBodiesToLoad() && !viewer.hasPendingWork()`, plus the
  body count standing still for ~400 ms. Big Assemblies stream for seconds.
- **Sketch drawings:** these arrive a while after the features. Wait for the drawn-entity count to stand still for
  ~2.5 s, at most ~15 s.
- **The connection:** see §8.1.

### 17.3 Rules

- A frame on **another document** gets no answers about this document's Assembly.
- **Edits from two sessions don't run in parallel. Reads and configuration builds in other sessions do.** Two helper
  sessions cut 10 builds from ~12 s to 4.6 s. A helper booting costs the main page time, so keep helpers open rather
  than opening them per job.
- **Caches don't cross frames.** A frame has its own modules and its own learned state, so send it everything a job
  needs.
- **Hide it from collaborators.** Every frame shows as an extra copy of the user's avatar to everyone in the document.
  - Right after appending the frame, before it connects (poll every 40 ms for its message classes), wrap the frame's
    `GBTClientFunctionality.prototype.writeData` to set `this.canBeFollowModeLeader = false`. A real browser client
    always sends true; `clientType` 1 means browser.
  - In each of your pages, wrap `ui.collaboration.GBTUiClientList.prototype.readData` to drop clients with
    `clientType === 1 && clientFunctionality.canBeFollowModeLeader === false`.
  - Users without that patch still see the avatars.
- **Background tabs:** Chrome freezes hidden browser tabs. Use `setTimeout`, not `requestAnimationFrame`, for anything
  that must keep going.

---

## 18. Theming and CSS

- **Tokens:** Onshape styles itself with `--os-*` CSS variables; override them to restyle.
  `ThemeService.overrideTheme("dark" | "light")` sets `data-os-theme` on `<body>` (session only, not saved), which
  re-bases every token and the 3D view. Restore with `getUserTheme()` / `getSessionTheme()`, and follow the user's own
  changes with `getThemeChangeObservable()`. The service exists only after boot.
- **The 3D view's colours** (view cube, sketch, dimensions) are read only on a theme change. To make it re-read, switch
  to the other theme and back **about 60 ms later** on a `setTimeout`; both at once was too fast.
- **Misleading token names:**
  - `--os-outline-primary` is the **stroke of outline icons** (white in dark mode). Keep it text-coloured, not a border
    colour.
  - `--os-icon-accent-primary` is Onshape's blue, which the Z axis of the mate and Measure arrows uses.
- **Full-window canvas:** if you make the 3D canvas full-window behind see-through panels, those panels must sit above
  it or the canvas takes their clicks. Call `viewer.onResize()` after moving it.
- **Drawings are a different app:** a frame on another host (`production-drawing-….onshape.com/editor`), built on Wt
  ("xenon" classes), with no `--os-*` tokens; its own `theme=dark` does nothing. It needs a content script with
  `all_frames`. The sheet is a WebGL canvas, which you can recolour with a CSS/SVG filter; display only, exports
  unaffected.
- **Which hosts:** apply CAD-app CSS on `cad.onshape.com` only, plus Enterprise `<company>.onshape.com` where
  `<html hybrid-app>` is present (it's in the served HTML at `document_start`). The CAD app's CSS breaks
  www.onshape.com. Leave Onshape's other sites alone (www, learn, forum, appstore).
- **Sign-in page picture:** a same-origin frame (`/sif/iframe/index.html`, a `.background` div) inside
  `.os-dynamic-signin-banner`, shown only on wide windows. The banner is the page's right half (`flex: 0 1 50%`).
- **Images:** Onshape's page loads no outside pictures, so inline them as `data:` URLs.

---

## 19. Keyboard

- Check `KeyboardShortcutsService.keyboardShortcutsMap.getValue()` before claiming a key. Taken examples:
  - Shift+T is Make transparent.
  - Plain A flips the primary axis inside a mate dialog, and in a sketch A is a 3-point arc.
  - Shift+A, Shift+K and Shift+J are sketch tools.
  - Shift+L is Perpendicular in sketches and Drawings.
  - Shift+C is curve analysis, and C is circle.
  - Almost every plain letter is used somewhere.
- Never react to keys while the user is typing: inputs, `contenteditable`, IME composition, and inputs inside your own
  shadow roots. Never react while one of Onshape's dialogs or menus is open either (a sketch counts as a dialog).
- Match `event.key`, not `event.code`, except with Alt or a non-Latin layout.
- Keys Onshape and the browser keep: Ctrl+C, V, Z, Y, T, Ctrl+Shift+Z, F5, the arrows (the camera).

---

## 20. Things that don't work

- Synthetic clicks on the 3D canvas.
- `updateSelectionList([array])`.
- Telling the tab type from the mini toolbar.
- Creating mate connectors with the Mate connector tool from code.
- Delayed regeneration in an Assembly.
- Paste with a rotation, or inserting straight into a folder.
- Pre-building configurations read-only so the later insert is faster.
- Suppressing mates to speed up a big Assembly: no end-to-end gain, and the solver moved the user's parts.
- Batching inserts and mates into one message: correct, but no end-to-end gain.
- `viewer.bodyManager.previewOccurrences`, which stays empty.
- `GBTUiSolveFullAssembly` from code.
- `restrictToConfigurationMap` with booleans, or for Assemblies.
- **Anything at all while Onshape shows "Onshape is not connected"**: nothing generates and no inferences come back.

---

## 21. Testing on the live site

- **Use test documents.** Anything that inserts leaves history, and even an Insert dialog opened and closed leaves an
  empty "Insert : " step. Never experiment in documents people depend on.
- **Don't edit a document just because it was opened.** Opening a page should never change anyone's document; for
  example, never insert a part somewhere far away to learn what it looks like.
- **Injecting code without installing an extension:**
  1. Bundle your page-side code into one IIFE (esbuild works).
  2. Serve it locally **as UTF-8**, or non-ASCII characters ("×", "±") arrive garbled and string matches fail only on
     the live site.
  3. Have a local page put the bundle in `window.name` and redirect to the Onshape address. `window.name` survives the
     navigation.
  4. Run `(0, eval)(window.name)` in the Onshape page. Frames can `frame.contentWindow.eval(...)` the same string.
- **Learn a message by recording:** wrap `writeToSocket`, do the thing by hand in Onshape's UI, and read what was sent.
- **Keep timestamped step logs** (`performance.now()`). Onshape's own timing varies ±1.5 s from run to run, and a fresh
  page's first job is much slower (first-time server work per session; first inserts answered after 3–6 s).
- **Tips:**
  - Screenshots can lag a step behind the page, so prefer reading state from the page.
  - A background or unfocused pane never fires `blur` and builds no geometry while hidden.
  - Keep CSS pixels and device pixels straight.
- **After each Onshape release**, re-check the selectors (`data-parameter-id`, query chips, the quantity component), the
  selection observable, and the preview data, the things that moved in 2026.
