/**
 * The User Guide's words. One entry per guide, in reading order.
 *
 * Written for someone who has never used the app and is not a BIM specialist:
 * one action per step, the control's own label in [[double brackets]] so it
 * shows as a key cap, and **bold** for the word that matters. `fig` names a
 * drawing in figures.js; `show` is where "Show me" points — the tab to open
 * and a CSS selector for the control, with a hint for when it is not on
 * screen yet.
 *
 * @typedef {{ tab?: string, target: string, hint?: string }} ShowMe
 * @typedef {{ title: string, text: string, fig?: string, show?: ShowMe }} Step
 * @typedef {{ id: string, title: string, summary: string, intro: string, needs?: string,
 *   keywords?: string, steps: Step[], result?: string, trouble?: {q: string, a: string}[] }} Section
 */

const NEEDS_MODEL = 'a model open. Drag an .ifc file onto the window, or use [[Add IFC file]] at the top left.';

/** @type {Section[]} */
export const SECTIONS = [
  {
    id: 'start',
    title: 'Start here: what this app does',
    summary: 'Check an IFC model for CORENET X before you submit it.',
    keywords: 'start begin overview introduction what corenet x ifc-sg privacy upload local screen layout',
    intro: 'RSP CX Radar opens your IFC model and checks it the way CORENET X will: is every element carrying ' +
      'the information each authority asks for, and was the file exported correctly? It shows you what to fix ' +
      'before you submit. **Nothing is uploaded.** Your files stay on your computer.',
    steps: [
      {
        title: 'Know your way around the screen',
        text: 'The **top bar** (1) opens models, the project and the Dashboard. The **tabs** (2) on the left switch ' +
          'what the panel beside them (3) shows. The **tool rail** (4) holds the view tools. The **3D view** (5) is ' +
          'the model itself, and clicking an element opens its **details** (6) on the right.',
        fig: 'o-layout',
        show: { target: '#left .tabs' },
      },
      {
        title: 'Follow the usual order',
        text: '**Load** the model, **set up the project**, clear the [[Warnings]], run the [[Compliance]] checks, ' +
          '**fix** missing values on [[CX Queries]], then raise [[Issues]] and make the PDF report. Each has its own ' +
          'guide below.',
      },
    ],
    result: 'You know which part of the screen does what, and which guide to read next.',
  },

  {
    id: 'around',
    title: 'Finding your way around the 3D view',
    summary: 'Turn, slide and zoom the model, and use the tool rail.',
    keywords: 'navigate mouse orbit rotate pan zoom rail fit plan view level section cut measure hide isolate show all right click menu ghost spaces',
    intro: 'The model moves with the mouse, and the narrow **tool rail** beside the panel has everything else. ' +
      'Point at any rail button to see what it does.',
    needs: NEEDS_MODEL,
    steps: [
      {
        title: 'Move the model with the mouse',
        text: 'Hold the **left** button and drag to turn the model. Hold the **right** button (or the wheel) and ' +
          'drag to slide it. Roll the **wheel** to zoom towards the pointer. A single left click selects an element.',
        fig: 'f-mouse',
      },
      {
        title: 'Use the tool rail',
        text: '[[Fit to View]] brings the whole model back into view. [[Plan View]] looks straight down on one level. ' +
          '[[Section Cut]] slices through the model, and [[Measure]] measures between two points. If things have ' +
          'disappeared, [[Show All]] brings everything back.',
        fig: 'f-rail',
        show: { target: '#rail' },
      },
      {
        title: 'Right-click an element',
        text: 'Right-click an element for a short menu: hide it, hide everything of its kind, **isolate** it so only ' +
          'it shows, or open its details.',
        fig: 'f-ctx',
      },
      {
        title: 'Make room',
        text: 'The top button on the rail, [[Collapse Panel]], folds the side panel down to its tabs. Click any tab to ' +
          'bring it back.',
        show: { target: '#tool-collapse' },
      },
    ],
    result: 'You can turn, slide and zoom freely, and get back to the full model with [[Fit to View]] and [[Show All]].',
    trouble: [
      { q: 'The model has vanished.',
        a: 'Press [[Show All]], then [[Fit to View]]. A [[Section Cut]] can also hide parts: click the tool again to stop it.' },
      { q: 'Rooms are covering everything.',
        a: '[[Show IfcSpaces]] on the rail turns the room volumes on and off.' },
    ],
  },

  {
    id: 'setup',
    title: 'Loading models and setting up the project',
    summary: 'Open your IFC files and tell the app which submission they are for.',
    keywords: 'load open add ifc file drag drop rspfrag large model project setup save gateway design construction authorities cadastral lot geojson',
    intro: 'A **project** remembers the details of a submission: its gateway, the authorities involved, the ' +
      'cadastral lot and the checks you chose. Save it once, and next time everything is set up again in one step.',
    steps: [
      {
        title: 'Open your model',
        text: 'Drag one or more **.ifc** files onto the window, or press [[Add IFC file]] at the top left. Load ' +
          'every file in the submission: they open together as one model. The same menu lists what is open, with ' +
          'an eye to hide a file and **×** to close it.',
        fig: 'l-load',
        show: { target: '#filename' },
      },
      {
        title: 'Open project setup',
        text: 'Click the project name in the top bar (it says [[No project]] at first). Fill in the **project code** ' +
          'and **name** (1).',
        fig: 'l-project',
        show: { target: '#project-chip' },
      },
      {
        title: 'Add the cadastral lot',
        text: 'Press [[Choose file…]] and pick the lot\'s **GeoJSON**, downloaded from URA\'s site-information ' +
          'service (2). The geo-referencing check uses it to make sure the model sits on the right site.',
      },
      {
        title: 'Choose the gateway and authorities',
        text: 'Set the **submission gateway**, Design or Construction (3): it decides which requirements apply. Tick ' +
          'the **authorities** in scope (4), or leave them all unticked to check against everyone.',
      },
      {
        title: 'Save the project',
        text: 'Press [[Save]] (5). The project is a small **.json** file: keep it with the model. Next time, open it ' +
          'from project setup with [[Open…]].',
      },
    ],
    result: 'The project name and gateway in the top bar, and every check and query limited to your submission.',
    trouble: [
      { q: 'A large file takes a long time to open.',
        a: 'Files of 30 MB or more are converted the first time. Then use the save arrow beside the file in the [[Add IFC file]] menu to keep a **.rspfrag** copy, which opens in seconds.' },
      { q: 'The project name shows a dot.',
        a: 'The project has changes that are not saved yet. Open project setup and press [[Save]].' },
    ],
  },

  {
    id: 'queries',
    title: 'CX Queries: colour the model by requirement',
    summary: 'See which elements an authority asks about, and which are missing information.',
    keywords: 'query filter colour color legend key set value bulk fill export ifc authority priority component property',
    intro: 'CORENET X expects certain information on certain elements: a **fire rating** on doors, a ' +
      '**construction method** on roofs, and so on. A query colours the model so you can see at a glance ' +
      'which elements have that information and which do not.',
    needs: NEEDS_MODEL,
    steps: [
      {
        title: 'Choose whose requirements to look at',
        text: 'On the [[CX Queries]] tab, click an **authority** such as [[BCA]] or [[URA]]. Leave it on [[All]] to see ' +
          'everyone\'s. You can narrow it further by **priority**: [[High]] is what to fix first.',
        fig: 'q-authority',
        show: { tab: 'query', target: '#agency-bubbles' },
      },
      {
        title: 'Click a component',
        text: 'The **Components** list shows the kinds of element the authority cares about, with how many your ' +
          'model has. Click one, such as [[Roof]]. Those elements are coloured in the model; everything else ' +
          'fades into the background.',
        fig: 'q-component',
        show: { tab: 'query', target: '#tree', hint: 'Load a model first to see its components.' },
      },
      {
        title: 'Click a property',
        text: 'Under the component, its **properties** appear. Click one. Now every element is coloured by the ' +
          'value it holds, and elements where nobody has filled the value in are **red**.',
        fig: 'q-property',
        show: { tab: 'query', target: '#tree', hint: 'Click a component first; its properties appear under it.' },
      },
      {
        title: 'Read the colour key',
        text: 'The **colour key** at the bottom of the 3D view says what each colour means and how many elements ' +
          'have it. Click a row to show only those elements; click it again to show them all. [[Clear]] ends the query.',
        fig: 'q-legend',
        show: { target: '#legend', hint: 'The colour key appears once you click a component or property.' },
      },
      {
        title: 'Fill in a missing value for many elements at once',
        text: 'With a property chosen, press [[Set value…]] in the colour key, pick or type the value, and press ' +
          '[[Set on …]]. When you are done, press [[Export IFC]] at the bottom to save a corrected copy of the file. ' +
          'Your original file is not changed.',
        fig: 'q-setvalue',
        show: { target: '#btn-set-value', hint: 'Set value… appears in the colour key once you click a property.' },
      },
    ],
    result: 'The elements you asked about in colour, the rest faded, and a colour key that counts them. Red ' +
      'elements are the ones still missing information.',
    trouble: [
      { q: 'A component I expect is not listed.',
        a: 'Untick [[Only components present in model]] at the top: the list then shows every component, including ones your model does not have yet.' },
      { q: 'Nothing changes colour.',
        a: 'The elements may be hidden. Press [[Show All]] on the tool rail (the eye icon), then try again.' },
      { q: 'I cannot find a component in the list.',
        a: 'Type part of its name in the [[Filter component or property…]] box above the list.' },
    ],
  },

  {
    id: 'search',
    title: 'Searching: find any element',
    summary: 'Browse the model by level, or search by name, ID or type.',
    keywords: 'search find model nav navigation tree level storey globalid name zoom isolate hide',
    intro: 'The [[Model Nav]] tab lists everything in your model by **file**, **level** and **type**, and ' +
      'has a search box for when you know what you are looking for.',
    needs: NEEDS_MODEL,
    steps: [
      {
        title: 'Browse by level',
        text: 'Open the [[Model Nav]] tab. Click the arrow beside a file, then a level, then a type such as ' +
          '[[IfcDoor]]. Point at any row to get [[Zoom]] (fly to it), [[Isolate]] (hide everything else) and ' +
          '[[Hide]].',
        fig: 's-tree',
        show: { tab: 'model', target: '#mt-body' },
      },
      {
        title: 'Search instead',
        text: 'Type in the search box: a name like **D-201**, a type like **door**, a level like **level 2**, or an ' +
          'element\'s GlobalId. Several words narrow it down. Tick [[Include property values]] to also search ' +
          'inside the information on each element.',
        fig: 's-search',
        show: { tab: 'model', target: '#mt-search' },
      },
      {
        title: 'Go to what you found',
        text: 'Click a result. The model turns to it, the element turns **magenta** to show it is selected, and ' +
          'its details open on the right. [[Show in model]] colours every result at once.',
        fig: 's-result',
        show: { tab: 'model', target: '#mt-search' },
      },
    ],
    result: 'The element selected in magenta, centred in the view, with its details in the panel on the right.',
    trouble: [
      { q: 'My element is not found.',
        a: 'Model Nav lists the elements CORENET X asks about. Furniture, annotations and similar are not listed.' },
      { q: 'I lost the rest of the model after Isolate.',
        a: 'Press [[Show All]] on the tool rail (the eye icon) to bring everything back.' },
    ],
  },

  {
    id: 'element',
    title: 'Checking one element',
    summary: 'See what one element is missing, and fill it in.',
    keywords: 'element panel details properties inspect select click fix edit value rename pset property set requirement',
    intro: 'Click any element and the panel on the right lists **every requirement** that applies to it, each ' +
      'with a green or red dot, followed by all the information the element carries.',
    needs: NEEDS_MODEL,
    steps: [
      {
        title: 'Click the element',
        text: 'Click it in the 3D view, or in a [[Model Nav]] search result. It turns **magenta** and its details ' +
          'open on the right.',
      },
      {
        title: 'Read the dots',
        text: 'Under each check\'s heading, a **green** dot means the requirement is met; **red** means it is ' +
          'missing or wrong (1). The value the element holds now is shown on the right of each row.',
        fig: 'e-panel',
        show: { target: '#panel', hint: 'Click an element in the 3D view first.' },
      },
      {
        title: 'Fix it here',
        text: 'Press [[Fix]] on a red row (2), choose or type the value, and press [[Save]]. The dot turns green. ' +
          'To fix the same property on **every** element at once, press [[All…]] instead (3): it opens the query ' +
          'with [[Set value…]].',
        fig: 'e-fix',
        show: { target: '#panel', hint: 'Click an element in the 3D view first.' },
      },
      {
        title: 'Save your changes to a new file',
        text: 'Edits wait in the bar at the bottom. Press [[Export IFC]] to save a corrected copy, or [[Discard]] to ' +
          'undo them all. Your original file is not changed.',
        show: { target: '#edits-bar', hint: 'The bar appears once you have made an edit.' },
      },
    ],
    result: 'Every requirement on the element in green, and a corrected IFC file saved beside the original.',
    trouble: [
      { q: 'There is no Fix button.',
        a: 'Editing needs the original .ifc file. A model opened from a **.rspfrag** copy can be checked but not edited: open the .ifc instead.' },
      { q: '"No requirements for this entity and subtype".',
        a: 'CORENET X asks nothing of this kind of element, or its **PredefinedType** or **ObjectType** is not one the mapping knows. Compare it with the subtype on the CX Queries tab.' },
    ],
  },

  {
    id: 'warnings',
    title: 'Warnings: problems that fail a submission',
    summary: 'Fix these first: CORENET X rejects a file that has them.',
    keywords: 'warning error fail review georeference georeferencing site building storey globalid origin far stray export revit',
    intro: 'Some problems come from how the file was **exported**, not from the design: a missing site, the ' +
      'wrong coordinates, duplicate IDs. CORENET X rejects the file outright for these, so the app checks for ' +
      'them as soon as a model opens.',
    needs: NEEDS_MODEL,
    steps: [
      {
        title: 'Open the Warnings tab',
        text: 'A number on the [[Warnings]] tab means something was found. **Will fail** problems are listed first ' +
          'and must be fixed. **Review** problems may be fine, but look at each one.',
        fig: 'w-list',
        show: { tab: 'warnings', target: '#warn-list' },
      },
      {
        title: 'Read what it means',
        text: 'Click a warning to open it. It says, in plain words, what is wrong and what usually causes it — ' +
          'most often a setting in Revit\'s IFC export.',
        fig: 'w-open',
        show: { tab: 'warnings', target: '#warn-list' },
      },
      {
        title: 'Find it in the model',
        text: 'Where elements are involved, [[Show in model]] colours them and [[Zoom to]] flies the view to them. ' +
          'Click a single element in the list to select it. Where a compliance check looks at the same thing, a ' +
          '**Related check** link takes you to it.',
        fig: 'w-model',
        show: { tab: 'warnings', target: '#warn-list' },
      },
      {
        title: 'Fix it at the source and re-export',
        text: 'Make the change in Revit (or your authoring tool), export the IFC again, and open the new file here. ' +
          'The warning disappears once the problem is gone.',
      },
    ],
    result: 'A green **No export problems found** at the top of the tab.',
    trouble: [
      { q: '"Not georeferenced" or "No IfcProjectedCRS".',
        a: 'In Revit\'s IFC export, set the coordinate base to **Shared Coordinates** and the coordinate system to **EPSG:3414 (SVY21)**.' },
      { q: '"Geometry is far from the file\'s origin".',
        a: 'Use [[Zoom to]] to find the stray element. It is often a forgotten object or a linked file placed in the wrong spot.' },
      { q: '"GlobalIds shared by more than one element".',
        a: 'Usually from copying elements between files. Re-export with **Store the IFC GUID in an element parameter after export** ticked.' },
    ],
  },

  {
    id: 'compliance',
    title: 'Compliance checks: test the model against CORENET X',
    summary: 'Run the checks, read the score, and see what fails.',
    keywords: 'compliance check run score percent issues pass fail colour report pdf rerun out of date ura bca geo',
    intro: 'Compliance checks test every element against the **IFC-SG mapping**: the official list of what each ' +
      'authority needs. Some checks also look at the site position and at URA\'s floor-area rules.',
    needs: NEEDS_MODEL + ' For the geo-referencing check, also the **cadastral lot** from URA, added in project setup.',
    steps: [
      {
        title: 'Choose the checks',
        text: 'On the [[Compliance]] tab, tick the checks to run. A check that needs extra information, such as ' +
          'the cadastral lot, says so under its name.',
        fig: 'c-pick',
        show: { tab: 'check', target: '#check-menu' },
      },
      {
        title: 'Run them',
        text: 'Press [[Run … checks]]. It takes a few seconds on a typical model.',
        show: { tab: 'check', target: '#btn-run-check' },
      },
      {
        title: 'Read the score',
        text: 'The green part of the bar is what passes. **% of requirements met** counts each requirement on each ' +
          'element — point at it for the exact numbers. Click the **issues** count to list only what fails.',
        fig: 'c-score',
        show: { tab: 'check', target: '#summary', hint: 'The score appears after the checks run.' },
      },
      {
        title: 'See the failures in the model',
        text: 'Each result below the score is one component or rule. Click one to colour its elements: **green** ' +
          'passes, **red** fails. Click a red element to see exactly which value is missing.',
        fig: 'c-results',
        show: { tab: 'check', target: '#issues', hint: 'The results appear after the checks run.' },
      },
      {
        title: 'Keep the results current, and share them',
        text: 'If you change the model or the project setup, the results say **Out of date**: press [[Re-run]]. ' +
          '[[Colour]] paints the whole model by pass and fail, [[To BCF]] turns every failure into an issue, and ' +
          '[[PDF report]] makes the submission readiness report.',
        fig: 'c-stale',
        show: { tab: 'check', target: '#btn-report' },
      },
    ],
    result: 'A score, a list of what fails with the worst first, and the failing elements in red.',
    trouble: [
      { q: 'The Run button is greyed out.',
        a: 'Tick at least one check, and make sure a model is open.' },
      { q: 'The geo-referencing check says the lot is missing.',
        a: 'Open project setup (the project name in the top bar) and add the cadastral lot GeoJSON, downloaded from URA\'s site-information service.' },
      { q: 'The checks ask about the wrong gateway.',
        a: 'The submission gateway is set in project setup. Change it there and press [[Re-run]].' },
    ],
  },

  {
    id: 'issues',
    title: 'Issues: raise, track and share problems',
    summary: 'Keep a to-do list of problems that Revit and CORENET X can read too.',
    keywords: 'issues bcf topic comment import export model checker revit acc assign status author',
    intro: 'Issues are saved as a **BCF** file: a standard to-do list for building models. Each issue remembers ' +
      'the elements and the view, so whoever opens it — here, in Revit, or in the CORENET X Model Checker — ' +
      'sees the same thing.',
    steps: [
      {
        title: 'Know where issues come from',
        text: 'Three ways in: **import** the BCF the CORENET X Model Checker gives you, **raise** your own on an ' +
          'element, or turn compliance failures into issues with [[To BCF]] on the Compliance tab.',
        fig: 'i-flow',
      },
      {
        title: 'Put your name on it',
        text: 'On the [[Issues]] tab, type your name in **Author**. It goes on every issue and comment you add.',
        fig: 'i-actions',
        show: { tab: 'issues', target: '#bcf-author' },
      },
      {
        title: 'Import, or raise a new one',
        text: '[[Import BCF…]] opens a BCF file. To raise your own, click the element in the model first, then ' +
          '[[New topic]]: give it a title and press [[Create]]. It saves the element and a picture of the view.',
        fig: 'i-new',
        show: { tab: 'issues', target: '#btn-bcf-new' },
      },
      {
        title: 'Work through it',
        text: 'Click an issue to open it. Set its **status** and who it is **assigned** to, add comments, and use ' +
          '[[Show in model]] to go to the elements it is about.',
        fig: 'i-topic',
        show: { tab: 'issues', target: '#bcf-list' },
      },
      {
        title: 'Send it back to the team',
        text: 'Press [[Export BCF]] to save the issues as a file. Your team opens it in Revit or ACC to fix the ' +
          'model, and their replies come back the same way.',
        show: { tab: 'issues', target: '#btn-bcf-export' },
      },
    ],
    result: 'A list of issues, each tied to elements and a view, saved as a .bcf file your team can open.',
    trouble: [
      { q: 'New topic says no element is attached.',
        a: 'Click the element in the 3D view first, so it turns magenta, then press [[New topic]].' },
      { q: 'Export BCF is greyed out.',
        a: 'There are no issues yet. Import a BCF or raise one first.' },
    ],
  },

  {
    id: 'dashboard',
    title: 'Dashboard: the submission\'s key figures',
    summary: 'Floor areas, parking, refuse and more, totalled from the model.',
    keywords: 'dashboard gfa gross floor area sgfa use quantum planting parking refuse recycling site coverage area quantities totals level file',
    intro: 'The Dashboard adds up the figures an authority reads from your model, such as **gross floor area** ' +
      'and **parking lots**, the same way CORENET X will. Check them against your own calculations before you submit.',
    needs: NEEDS_MODEL,
    steps: [
      {
        title: 'Open the Dashboard',
        text: 'Press [[Dashboard]] in the top bar. Choose how to break the totals down (1): [[By level]], ' +
          '[[By file]] or [[Totals only]].',
        fig: 'd-cards',
        show: { target: '#btn-dash' },
      },
      {
        title: 'Read each card',
        text: 'Each card is one figure (2). **OK** means every element counted has its value; a yellow note means ' +
          'some elements have no value, so the total is **too low**.',
      },
      {
        title: 'Find out why a figure is missing',
        text: 'Figures the model does not contain are listed last, folded (3). Open one: it says whether nothing is ' +
          'modelled, or the elements are there but typed in a way the authority\'s query will not find.',
      },
      {
        title: 'See the elements behind a figure',
        text: '[[Show in model]] (4) colours every element counted in that card. Where some have no value, ' +
          '[[Show not set]] picks out just those, ready to fix.',
      },
    ],
    result: 'Totals you can compare with your area schedule, and a list of anything that would come out wrong.',
    trouble: [
      { q: 'A figure is lower than my schedule.',
        a: 'Look for a yellow note on the card: elements without a value are not added. Use [[Show not set]] and fill them in.' },
      { q: 'A file I closed still counts.',
        a: 'The project remembers each model\'s figures from the last time it was open, so the Dashboard covers the whole submission. Forget a file in project setup to take it out.' },
    ],
  },

  {
    id: 'trouble',
    title: 'Troubleshooting',
    summary: 'Quick answers when something does not look right.',
    keywords: 'help problem error slow memory crash blank browser chrome edge file will not open stuck missing',
    intro: 'If your question is not here, use the [[Feedback]] tab to tell us. Say what you did and what you ' +
      'expected to happen.',
    steps: [],
    trouble: [
      { q: 'The file will not open.',
        a: 'Only **.ifc** files and the app\'s own **.rspfrag** copies open. If an .ifc still fails, the export may have stopped part-way: export it again from Revit.' },
      { q: 'The app is slow, or the tab crashes.',
        a: 'Watch the **Memory** meter at the top right. Close models you are not using, and open very large files once to save a **.rspfrag** copy, which opens in seconds. Chrome or Edge works best.' },
      { q: 'The 3D view is blank after loading.',
        a: 'Press [[Show All]], then [[Fit to View]]. If it is still blank, look for a **Geometry is far from the file\'s origin** warning: one stray element can push the view far away.' },
      { q: 'The checks and the element panel disagree.',
        a: 'The results may be **Out of date** after an edit. Press [[Re-run]] on the Compliance tab.' },
      { q: 'An element lists no requirements.',
        a: 'Check the gateway and authorities in project setup: requirements outside them are left out on purpose.' },
      { q: 'I closed the tab by mistake.',
        a: 'Edits that were not exported are lost, but a saved project reopens with all its settings. Save the project and export edits as you go.' },
    ],
  },
];
