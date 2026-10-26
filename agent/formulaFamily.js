// Pure formula classification shared by the local monitor and cloud writers.
const columnIndex = (value) => [...value].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
export function formulaFamily(formula, address) {
  const [, column, rowText] = address.match(/^([A-Z]+)([1-9]\d*)$/);
  const col = columnIndex(column), row = +rowText - 1;
  return formula.replace(
    /"(?:[^"]|"")*"|'(?:[^']|'')+'!|[\p{L}_][\p{L}\p{N}_ .]*!|(?<![\p{L}\p{N}_])\$?[A-Z]{1,3}\$?[1-9]\d*(?![\p{L}\p{N}_(]|!)/gu,
    (token) => {
      const m = token.match(/^(\$?)([A-Z]+)(\$?)([1-9]\d*)$/);
      if (!m) return token;
      return `R${m[3] ? "=" + m[4] : "[" + (+m[4] - 1 - row) + "]"}C${m[1] ? "=" + m[2] : "[" + (columnIndex(m[2]) - col) + "]"}`;
    },
  );
}
