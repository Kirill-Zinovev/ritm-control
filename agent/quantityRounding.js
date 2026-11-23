export function quantityRounding(requested, step, { minimum = 1, maximum = Infinity } = {}) {
  if (!Number.isSafeInteger(requested) || requested <= 0 || !Number.isSafeInteger(step) || step <= 0) return null;
  const remainder = requested % step;
  if (!remainder) return null;
  const lower = requested - remainder;
  return [
    { direction: "down", quantity: lower },
    { direction: "up", quantity: lower + step },
  ].filter(({ quantity }) => quantity >= minimum && quantity <= maximum);
}
