export type RepairResult = {
  at: string;
  errorCode?: string;
  message?: string;
  after?: {
    cell: unknown;
    effective: {
      numberValue?: number;
      stringValue?: string;
      boolValue?: boolean;
    };
  };
  api?: { writeRequests: number };
};

export function repairReadback(result: RepairResult | null | undefined) {
  const after = result?.after;
  return after &&
    typeof after.effective === "object" &&
    after.effective !== null
    ? after
    : null;
}

export function repairStatusMessage(
  result: RepairResult | null | undefined,
  cell: string,
) {
  if (result?.errorCode === "repair_operation_conflict")
    return `Попытка для ${cell} остановлена до записи, пока завершалась другая проверка. Таблица не менялась; предложение нужно подготовить заново.`;
  return result?.message || null;
}
