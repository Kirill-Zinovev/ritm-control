// Recheck only while the server reports an active write; never overlap polls.
export function startWriterStatusPolling(refresh, delay = 2500) {
  let stopped = false;
  let timer;
  const schedule = () => { if (!stopped) timer = setTimeout(run, delay); };
  const run = async () => {
    try { await refresh(); } finally { schedule(); }
  };
  schedule();
  return () => { stopped = true; clearTimeout(timer); };
}
