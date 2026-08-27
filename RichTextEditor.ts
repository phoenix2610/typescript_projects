// Rich Text Editor Core
//
// A contenteditable surface where bold/italic are applied by walking the
// real Selection Range — not `document.execCommand`, which is deprecated
// and gives you no control over the markup it produces. Toggling wraps the
// selected Range in a `<strong>`/`<em>` element, or un-wraps it if the
// selection already sits inside one. After every change the DOM is
// serialized into a small document model (paragraphs of text runs, each
// carrying its own bold/italic flags) so there's a real, inspectable
// source of truth rather than "whatever contenteditable produced". Undo
// snapshots the editor's HTML immediately after each formatting command,
// and after a typing pause, rather than after every keystroke.
//
// Usage:
//   mount(document.getElementById('app'));
//
// `serialize`, `toggleFormat`, `Editor` are exported for reuse.

export interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
}

export interface ParagraphNode {
  type: 'paragraph';
  runs: Run[];
}

export function serialize(root: HTMLElement): ParagraphNode[] {
  const topChildren = Array.from(root.childNodes);
  const hasBlockChildren = topChildren.some(
    (n) => n.nodeType === 1 && ['P', 'DIV'].includes((n as Element).tagName),
  );
  const blockNodes: Node[] = hasBlockChildren
    ? topChildren.filter((n) => n.nodeType === 1 || (n.nodeType === 3 && !!n.textContent?.trim()))
    : [root];

  const blocks: ParagraphNode[] = [];
  for (const blockNode of blockNodes) {
    const runs: Run[] = [];
    collectRuns(blockNode, false, false, runs);
    blocks.push({ type: 'paragraph', runs });
  }
  return blocks;
}

function collectRuns(node: Node, bold: boolean, italic: boolean, runs: Run[]) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      const text = child.textContent ?? '';
      if (text) runs.push({ text, bold, italic });
    } else if (child.nodeType === 1) {
      const tag = (child as Element).tagName.toLowerCase();
      collectRuns(child, bold || tag === 'strong', italic || tag === 'em', runs);
    }
  }
}

function findAncestorTag(node: Node, tag: string, root: HTMLElement): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && (cur as Element).tagName.toLowerCase() === tag) return cur as HTMLElement;
    cur = cur.parentNode;
  }
  return null;
}

function unwrap(el: HTMLElement) {
  const parent = el.parentNode!;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

export function toggleFormat(root: HTMLElement, tag: 'strong' | 'em') {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);

  const ancestor = findAncestorTag(range.commonAncestorContainer, tag, root);
  if (ancestor) {
    unwrap(ancestor);
    return;
  }

  const wrapper = document.createElement(tag);
  try {
    range.surroundContents(wrapper);
  } catch {
    // The selection spans multiple sibling nodes, which surroundContents
    // can't handle directly -- extract the fragment, wrap it, put it back.
    const contents = range.extractContents();
    wrapper.appendChild(contents);
    range.insertNode(wrapper);
  }
}

export class Editor {
  private history: string[] = [];
  private pointer = -1;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private root: HTMLElement, private onChange: (doc: ParagraphNode[]) => void) {
    this.pushSnapshot();
    this.emit(); // reflect the initial content immediately, not just after the first edit
    root.addEventListener('input', () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.pushSnapshot(), 400);
      this.emit();
    });
  }

  private emit() {
    this.onChange(serialize(this.root));
  }

  private pushSnapshot() {
    const html = this.root.innerHTML;
    if (this.history[this.pointer] === html) return;
    this.history = [...this.history.slice(0, this.pointer + 1), html];
    this.pointer = this.history.length - 1;
  }

  toggle(tag: 'strong' | 'em') {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    toggleFormat(this.root, tag);
    this.pushSnapshot();
    this.emit();
  }

  get canUndo() {
    return this.pointer > 0;
  }
  get canRedo() {
    return this.pointer < this.history.length - 1;
  }

  undo() {
    if (!this.canUndo) return;
    this.pointer -= 1;
    this.root.innerHTML = this.history[this.pointer];
    this.emit();
  }

  redo() {
    if (!this.canRedo) return;
    this.pointer += 1;
    this.root.innerHTML = this.history[this.pointer];
    this.emit();
  }
}

// ---- Demo -----------------------------------------------------------------

export function mount(root: HTMLElement) {
  root.innerHTML = '';
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '16px';
  root.style.maxWidth = '420px';

  const toolbar = document.createElement('div');
  toolbar.style.marginBottom = '8px';

  const boldBtn = document.createElement('button');
  boldBtn.textContent = 'Bold';
  boldBtn.setAttribute('data-testid', 'bold-btn');

  const italicBtn = document.createElement('button');
  italicBtn.textContent = 'Italic';
  italicBtn.setAttribute('data-testid', 'italic-btn');
  italicBtn.style.marginLeft = '4px';

  const undoBtn = document.createElement('button');
  undoBtn.textContent = 'Undo';
  undoBtn.setAttribute('data-testid', 'undo-btn');
  undoBtn.style.marginLeft = '12px';

  const redoBtn = document.createElement('button');
  redoBtn.textContent = 'Redo';
  redoBtn.setAttribute('data-testid', 'redo-btn');
  redoBtn.style.marginLeft = '4px';

  toolbar.append(boldBtn, italicBtn, undoBtn, redoBtn);

  const surface = document.createElement('div');
  surface.contentEditable = 'true';
  surface.setAttribute('data-testid', 'editor');
  surface.style.border = '1px solid #333';
  surface.style.padding = '8px';
  surface.style.minHeight = '80px';
  surface.style.fontSize = '14px';
  surface.textContent = 'Hello world, this is a rich text editor.';

  const modelView = document.createElement('pre');
  modelView.setAttribute('data-testid', 'model-json');
  modelView.style.fontSize = '10px';
  modelView.style.background = '#161b22';
  modelView.style.padding = '6px';
  modelView.style.marginTop = '8px';
  modelView.style.maxHeight = '160px';
  modelView.style.overflow = 'auto';

  // `editor` is declared before use because the Editor constructor calls
  // `onChange` synchronously (its constructor calls emit()), which would
  // otherwise try to read `editor.canUndo` while the `const editor = ...`
  // assignment it's part of hasn't finished yet.
  let editor: Editor;
  function refreshHistoryButtons() {
    if (!editor) return;
    undoBtn.toggleAttribute('disabled', !editor.canUndo);
    redoBtn.toggleAttribute('disabled', !editor.canRedo);
  }

  editor = new Editor(surface, (doc) => {
    modelView.textContent = JSON.stringify(doc, null, 2);
    refreshHistoryButtons();
  });

  boldBtn.addEventListener('click', () => editor.toggle('strong'));
  italicBtn.addEventListener('click', () => editor.toggle('em'));
  undoBtn.addEventListener('click', () => editor.undo());
  redoBtn.addEventListener('click', () => editor.redo());
  refreshHistoryButtons();

  root.append(toolbar, surface, modelView);
}

export default mount;
