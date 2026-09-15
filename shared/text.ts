// The gateway's streaming pass often returns unpunctuated text for continuous
// speech, and never marks sentence ends for languages the model punctuates
// weakly. These helpers keep display, saved text and clipboard output readable
// without inventing words: line breaks follow the model's own punctuation, and
// a closing mark is only ever derived from a silence the VAD actually measured.
const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/;
const CLOSING = /[。．.！!？?；;：:，,、…～~‐-―)）\]】》」』"'"']$/;
const SENTENCE_BREAK = /([。！？；…]+|[.!?;]+(?=\s|$))/g;
export function endsClosed(text: string) {
  return CLOSING.test(text.trim());
}
// '，' after a short pause inside one utterance, '。' after a full stop.
export function pauseMark(text: string, continued: boolean) {
  const trimmed = text.trim();
  if (!trimmed || endsClosed(trimmed)) return '';
  return CJK.test(trimmed) ? (continued ? '，' : '。') : continued ? ',' : '.';
}
export function readableText(text: string, mark = '') {
  const trimmed = text.trim();
  return trimmed ? trimmed + mark : trimmed;
}
// One line per sentence the model marked; long unpunctuated speech stays whole.
export function sentenceLines(text: string, mark = '') {
  const readable = readableText(text, mark);
  if (!readable) return [];
  const lines: string[] = [];
  let rest = readable;
  for (;;) {
    SENTENCE_BREAK.lastIndex = 0;
    const match = SENTENCE_BREAK.exec(rest);
    if (!match) break;
    const cut = match.index + match[0].length;
    if (cut >= rest.length) break;
    lines.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) lines.push(rest);
  return lines;
}
