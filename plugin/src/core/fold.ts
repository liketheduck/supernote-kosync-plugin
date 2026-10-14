// Text comparison form shared by every anchor operation on the device.
//
// Mirrors the published folding rule of Calibre-Web-NextGen's text anchors
// (cps/services/text_anchor.py `_fold`): whitespace and invisible characters
// vanish, dash and quote variants unify, accents are removed and letters are
// lower-cased. Two tokenizers never agree on spacing or punctuation glyphs, so
// comparison works on this character stream rather than on words.
//
// Outbound anchors are sent as raw words (the server folds them itself), so
// this function only has to be consistent with itself: inbound anchors and the
// reader's page text are both folded here before comparing.

const DROPPED = new Set(['\u00ad', '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff']);
const DASHES = new Set(['\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015', '\u2212']);
const QUOTES: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'",
  '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u201f': '"',
};

// Combining marks left after compatibility decomposition. Unicode property
// escapes are used when the JavaScript engine supports them; otherwise the
// common combining blocks are removed explicitly.
const MARKS: RegExp = (() => {
  try {
    return new RegExp('\\p{Mn}', 'gu');
  } catch {
    return /[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7\u06e8\u06ea-\u06ed\u0900-\u0903\u093a-\u094f\u0951-\u0957\u0962\u0963\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\u3099\u309a\ufe20-\ufe2f]/g;
  }
})();

const canNormalize = (() => {
  try {
    return '\u00e9'.normalize('NFKD').length === 2;
  } catch {
    return false;
  }
})();

const WHITESPACE = /\s/;

function foldChar(char: string): string {
  if (WHITESPACE.test(char) || DROPPED.has(char)) {
    return '';
  }
  if (DASHES.has(char)) {
    return '-';
  }
  const quote = QUOTES[char];
  if (quote !== undefined) {
    return quote;
  }
  const decomposed = canNormalize ? char.normalize('NFKD') : char;
  return decomposed.replace(MARKS, '').toLowerCase();
}

/** Folded form of `text`. */
export function fold(text: string): string {
  let out = '';
  for (const char of text) {
    out += foldChar(char);
  }
  return out;
}

/**
 * Folded form of `text` plus, for each folded UTF-16 unit, the index in `text`
 * of the character it came from. Used to report where in a page a match starts.
 */
export function foldWithOrigin(text: string): {folded: string; origin: number[]} {
  let folded = '';
  const origin: number[] = [];
  let index = 0;
  for (const char of text) {
    const part = foldChar(char);
    folded += part;
    for (let i = 0; i < part.length; i++) {
      origin.push(index);
    }
    index += char.length;
  }
  return {folded, origin};
}

const NON_LETTER: RegExp = (() => {
  try {
    return new RegExp('[^\\p{L}]', 'gu');
  } catch {
    return /[\s\d!-/:-@[-`{-~\u00a0-\u00bf\u2000-\u206f\u3000-\u303f]/g;
  }
})();

/**
 * Letters only: the folded form without digits, punctuation or symbols. Used
 * when strict matching finds nothing, e.g. editions that print line numbers
 * inside the text, or markup the reader renders with different punctuation.
 */
export function foldLetters(text: string): string {
  return fold(text).replace(NON_LETTER, '');
}
