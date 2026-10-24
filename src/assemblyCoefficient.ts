// This is the reported sum of sources, not a deduplicated productivity total.
// A missing coefficient must remain unknown rather than becoming zero.
export function sourceCoefficientSum(
  contributions: ReadonlyArray<{ coefficient: number | null }> | undefined,
  fallback: number | null = null,
): number | null {
  if (!contributions?.length) return fallback;
  if (
    contributions.some(
      (source) =>
        source.coefficient === null || !Number.isFinite(source.coefficient),
    )
  )
    return null;
  return contributions.reduce(
    (sum, source) => sum + (source.coefficient ?? 0),
    0,
  );
}

// Repeated article entries are separate work, not duplicates. Keep the complete
// history and only group within the same employee, day, supply and operation.
export function groupWorkEvents<
  T extends {
    date: string;
    employeeId: string;
    shipmentId: string;
    article: string;
    operationId: string;
    quantity: number;
    coefficient: number | null;
    createdAt: string;
  },
>(events: readonly T[]) {
  const groups = new Map<
    string,
    {
      key: string;
      first: T;
      events: T[];
      quantity: number;
      coefficient: number | null;
    }
  >();
  for (const event of events) {
    const key = JSON.stringify([
      event.date,
      event.employeeId,
      event.shipmentId,
      event.article,
      event.operationId,
    ]);
    const group = groups.get(key) || {
      key,
      first: event,
      events: [],
      quantity: 0,
      coefficient: 0,
    };
    group.events.push(event);
    group.quantity += event.quantity;
    group.coefficient = sourceCoefficientSum([
      { coefficient: group.coefficient },
      { coefficient: event.coefficient },
    ]);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    events: [...group.events].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    ),
  }));
}
