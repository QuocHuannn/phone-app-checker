// Child process for tests/report-fuzz.test.ts: writes the same report path again and again.
//   argv: <path> <id> <iterations>
import { writeReport } from '../../src/report.ts';
import { reportRows } from '../helpers/report-rows.ts';

const [pathArg, idArg, iterationsArg] = process.argv.slice(2);
if (pathArg === undefined || idArg === undefined || iterationsArg === undefined) {
  throw new Error('usage: report-writer <path> <id> <iterations>');
}
const id = Number(idArg);
const iterations = Number(iterationsArg);
for (let i = 0; i < iterations; i += 1) {
  writeReport(pathArg, reportRows(id, i % 2), { force: true });
}
