const collator = new Intl.Collator('ru',{numeric:true});

export function buildJobFilterIndex(rows, groups) {
  const fields = groups.map(([key,,read]) => ({key,read,options:new Set()}));
  const indexedRows = rows.map(row => {
    const values = {};
    for (const {key,read,options} of fields) {
      const value = read(row);
      values[key] = value;
      if (value) options.add(value);
    }
    return {row,values};
  });
  const options = Object.fromEntries(fields.map(field => [
    field.key,[...field.options].sort(collator.compare),
  ]));
  return {indexedRows,options};
}

export function filterJobRows(index, filters, includeRow) {
  const active = Object.entries(filters)
    .filter(([key,values]) => values.length && Object.hasOwn(index.options,key))
    .map(([key,values]) => [key,new Set(values)]);
  const result = [];
  for (const {row,values} of index.indexedRows) {
    if (active.every(([key,chosen]) => chosen.has(values[key])) && includeRow(row)) result.push(row);
  }
  return result;
}

export function selectedJobRows(rows, checked, eligible) {
  return rows.filter(row => checked.has(row.id) && eligible.has(row.id));
}
