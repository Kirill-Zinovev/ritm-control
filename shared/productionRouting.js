// X is reserved for Xerox. Contradictory catalog values require correction;
// neither automatic routing nor an explicit move may silently guess a machine.
export function xeroxExtensionIssue(department, machine, extension) {
  if (String(extension || '').trim().toUpperCase() !== 'X') return null;
  if (department === 'box' && String(machine || '').trim().toUpperCase() === 'XEROX') return null;
  const label = String(machine || '').trim() || 'не указан';
  return `Расширение X относится к Xerox — участку «Бокс», но указан станок «${label}». Проверьте станок и расширение в базе.`;
}
