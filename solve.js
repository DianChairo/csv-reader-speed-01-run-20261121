// Fast drop-in for csv-reader 1.0.0: run(input) returns exactly what csv-reader's
// readCsv returns for {text, header} -> {columns, rows, errors}.
//
// Same reading policy, written for speed: one pass, fields cut out with slice()
// instead of built a character at a time, and the hot unquoted-field scan is a
// tight charCodeAt loop that only stops at a comma, LF or CR. Quoted fields are
// scanned with a regex for the next quote/CR/LF so a clean quoted field is one
// exec plus one slice. No state is kept between calls.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Next quote, CR or LF at or after lastIndex, inside a quoted field.
  const Q = /["\r\n]/g;

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let fieldQuoted = false;
    let ended = END;

    // One field per turn; a field that ends at a comma starts another.
    for (;;) {
      let value;
      let init = '';
      let junkMode = false;
      let done = false;
      fieldQuoted = text.charCodeAt(pos) === 34;

      if (fieldQuoted) {
        // A field that opens with a quote runs to the next quote that is not doubled.
        const open = pos;
        const openLine = line;
        let seg = pos + 1;
        let parts = null;
        let closed = -1;
        Q.lastIndex = pos + 1;
        let m;
        while ((m = Q.exec(text)) !== null) {
          const j = m.index;
          const c = text.charCodeAt(j);
          if (c === 34) {
            if (text.charCodeAt(j + 1) === 34) {
              // "" inside quotes is one quote.
              if (parts === null) parts = [];
              parts.push(text.slice(seg, j), '"');
              Q.lastIndex = j + 2;
              seg = j + 2;
              continue;
            }
            closed = j;
            break;
          }
          // CRLF and a lone CR inside quotes are each one LF.
          if (parts === null) parts = [];
          parts.push(text.slice(seg, j), '\n');
          line += 1;
          if (c === 13 && text.charCodeAt(j + 1) === 10) {
            Q.lastIndex = j + 2;
            seg = j + 2;
          } else {
            Q.lastIndex = j + 1;
            seg = j + 1;
          }
        }
        if (closed < 0) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          line = openLine;
          init = '"';
          // Fall through to the unquoted scan below.
        } else {
          const qval = parts === null ? text.slice(open + 1, closed) : (parts.push(text.slice(seg, closed)), parts.join(''));
          pos = closed + 1;
          if (pos >= n) {
            value = qval;
            ended = END;
            done = true;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              value = qval;
              ended = COMMA;
              pos += 1;
              done = true;
            } else if (c === 10) {
              value = qval;
              ended = LINE_BREAK;
              pos += 1;
              line += 1;
              done = true;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              value = qval;
              ended = LINE_BREAK;
              pos += 2;
              line += 1;
              done = true;
            } else {
              // What follows the closing quote is appended as it stands.
              init = qval;
              junkMode = true;
            }
          }
        }
      }

      if (!done) {
        // Unquoted scan from pos, starting with init: up to the next comma or
        // line break. A CR not followed by LF is dropped (stray_cr) and the
        // field goes on. `added` counts the characters kept, for quote_junk.
        let parts = null;
        let segStart = pos;
        let added = 0;
        let p = pos;
        for (;;) {
          let j = p;
          while (j < n) {
            const c = text.charCodeAt(j);
            // Comma, LF and CR are all below 45, and so is nothing else a
            // field is usually made of: one comparison skips most characters.
            if (c < 45 && (c === 44 || c === 10 || c === 13)) break;
            j += 1;
          }
          if (j >= n) {
            if (parts === null) value = init === '' ? text.slice(segStart) : init + text.slice(segStart);
            else {
              parts.push(text.slice(segStart));
              value = parts.join('');
            }
            added += n - segStart;
            ended = END;
            pos = n;
            break;
          }
          const c = text.charCodeAt(j);
          if (c === 44) {
            if (parts === null) value = init === '' ? text.slice(segStart, j) : init + text.slice(segStart, j);
            else {
              parts.push(text.slice(segStart, j));
              value = parts.join('');
            }
            added += j - segStart;
            ended = COMMA;
            pos = j + 1;
            break;
          }
          if (c === 10) {
            if (parts === null) value = init === '' ? text.slice(segStart, j) : init + text.slice(segStart, j);
            else {
              parts.push(text.slice(segStart, j));
              value = parts.join('');
            }
            added += j - segStart;
            ended = LINE_BREAK;
            pos = j + 1;
            line += 1;
            break;
          }
          if (text.charCodeAt(j + 1) === 10) {
            // CRLF ends the record.
            if (parts === null) value = init === '' ? text.slice(segStart, j) : init + text.slice(segStart, j);
            else {
              parts.push(text.slice(segStart, j));
              value = parts.join('');
            }
            added += j - segStart;
            ended = LINE_BREAK;
            pos = j + 2;
            line += 1;
            break;
          }
          // Lone CR: dropped, the field goes on.
          if (parts === null) parts = init === '' ? [] : [init];
          parts.push(text.slice(segStart, j));
          added += j - segStart;
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          p = j + 1;
          segStart = j + 1;
        }
        if (junkMode && added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      }

      fields.push(value);
      if (ended !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !fieldQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
