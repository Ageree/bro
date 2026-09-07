export function formatJobWakeLine(j: {
  _id: string;
  goal: string;
  doneWhen: string;
  status: string;
  waitingFor?: string;
  note?: string;
  emailMessageId?: string;
}): string {
  const wait = j.waitingFor ? ` waitingFor=${j.waitingFor}` : "";
  const note = j.note ? ` note=${j.note}` : "";
  const mail = j.emailMessageId ? ` emailMessageId=${j.emailMessageId}` : "";
  return `id=${j._id} goal="${j.goal}" doneWhen="${j.doneWhen}" status=${j.status}${wait}${note}${mail}`;
}
