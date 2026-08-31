// Client-Side Fuzzy Search Index
//
// Builds an inverted index (token -> set of document ids) over a small
// corpus, then ranks results for a query: exact token hits score highest,
// near-miss tokens (typos) are matched by Levenshtein edit distance and
// score lower the further they drift from what was typed.
//
// Usage:
//   import { mount } from './FuzzySearchIndex';
//   mount(document.getElementById('app'));
//
// `buildIndex` / `search` are also exported standalone for reuse outside
// the demo UI.

export interface Doc {
  id: number;
  title: string;
}

export interface Index {
  docs: Doc[];
  postings: Map<string, Set<number>>; // token -> doc ids
  vocabulary: string[];
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export function buildIndex(docs: Doc[]): Index {
  const postings = new Map<string, Set<number>>();
  for (const doc of docs) {
    for (const token of tokenize(doc.title)) {
      let set = postings.get(token);
      if (!set) {
        set = new Set();
        postings.set(token, set);
      }
      set.add(doc.id);
    }
  }
  return { docs, postings, vocabulary: [...postings.keys()] };
}

export function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[rows - 1][cols - 1];
}

export interface SearchHit {
  doc: Doc;
  score: number;
  matchedTokens: { queryToken: string; indexToken: string; distance: number }[];
}

export function search(index: Index, query: string, maxDistance = 2): SearchHit[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const scoreByDoc = new Map<number, number>();
  const matchesByDoc = new Map<number, SearchHit['matchedTokens']>();

  for (const qToken of queryTokens) {
    let bestDistance = Infinity;
    let bestTokens: string[] = [];

    if (index.postings.has(qToken)) {
      bestDistance = 0;
      bestTokens = [qToken];
    } else {
      const threshold = Math.max(1, Math.floor(qToken.length / 3));
      for (const vocabToken of index.vocabulary) {
        const d = levenshtein(qToken, vocabToken);
        if (d > Math.min(maxDistance, threshold)) continue;
        if (d < bestDistance) {
          bestDistance = d;
          bestTokens = [vocabToken];
        } else if (d === bestDistance) {
          bestTokens.push(vocabToken);
        }
      }
    }

    if (!isFinite(bestDistance)) continue;

    for (const indexToken of bestTokens) {
      const docIds = index.postings.get(indexToken);
      if (!docIds) continue;
      const points = 10 - bestDistance * 3;
      for (const docId of docIds) {
        scoreByDoc.set(docId, (scoreByDoc.get(docId) ?? 0) + points);
        const list = matchesByDoc.get(docId) ?? [];
        list.push({ queryToken: qToken, indexToken, distance: bestDistance });
        matchesByDoc.set(docId, list);
      }
    }
  }

  const hits: SearchHit[] = [];
  for (const [docId, score] of scoreByDoc) {
    const doc = index.docs.find((d) => d.id === docId);
    if (!doc) continue;
    hits.push({ doc, score, matchedTokens: matchesByDoc.get(docId) ?? [] });
  }
  return hits.sort((a, b) => b.score - a.score);
}

const CORPUS: Doc[] = [
  { id: 1, title: 'Configure the color contrast checker' },
  { id: 2, title: 'Debounce the search input handler' },
  { id: 3, title: 'Write a binary search tree in TypeScript' },
  { id: 4, title: 'Fix the flexbox layout on the settings page' },
  { id: 5, title: 'Add pagination to the results table' },
  { id: 6, title: 'Cache API responses in IndexedDB' },
  { id: 7, title: 'Refactor the button component variants' },
  { id: 8, title: 'Profile the render performance of the dashboard' },
  { id: 9, title: 'Set up continuous integration for the monorepo' },
  { id: 10, title: 'Write unit tests for the checkout flow' },
];

export function mount(root: HTMLElement) {
  const index = buildIndex(CORPUS);

  root.innerHTML = '';
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.maxWidth = '520px';
  root.style.padding = '16px';

  const input = document.createElement('input');
  input.setAttribute('aria-label', 'Search');
  input.placeholder = 'Try "serach" or "flexbx"…';
  input.style.width = '100%';
  input.style.padding = '8px';
  input.style.fontSize = '14px';

  const resultsEl = document.createElement('ul');
  resultsEl.setAttribute('data-testid', 'results');
  resultsEl.style.listStyle = 'none';
  resultsEl.style.padding = '0';
  resultsEl.style.marginTop = '12px';
  resultsEl.style.fontSize = '13px';

  function render() {
    const hits = search(index, input.value);
    resultsEl.innerHTML = '';
    for (const hit of hits) {
      const li = document.createElement('li');
      li.setAttribute('data-testid', 'result-row');
      li.setAttribute('data-doc-id', String(hit.doc.id));
      li.setAttribute('data-score', String(hit.score));
      li.style.padding = '4px 0';

      const title = document.createElement('span');
      title.textContent = hit.doc.title;
      li.appendChild(title);

      const fuzzy = hit.matchedTokens.filter((m) => m.distance > 0);
      if (fuzzy.length > 0) {
        const note = document.createElement('span');
        note.setAttribute('data-testid', 'fuzzy-note');
        note.style.opacity = '0.6';
        note.style.marginLeft = '6px';
        note.textContent = fuzzy.map((m) => `("${m.queryToken}" ~ "${m.indexToken}")`).join(' ');
        li.appendChild(note);
      }
      resultsEl.appendChild(li);
    }
    if (input.value.trim() && hits.length === 0) {
      const li = document.createElement('li');
      li.setAttribute('data-testid', 'no-results');
      li.textContent = 'No matches';
      resultsEl.appendChild(li);
    }
  }

  input.addEventListener('input', render);
  root.appendChild(input);
  root.appendChild(resultsEl);
  render();
}

export default mount;
