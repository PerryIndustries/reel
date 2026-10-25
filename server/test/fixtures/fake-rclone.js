// `backend copyid` copies the `_Src` file of the listing entry with that ID; FAKE_RCLONE_LOG logs argv.
// Stand-in for rclone in tests. lsjson prints the JSON file at FAKE_RCLONE_LIST; sync copies the
// tree at FAKE_RCLONE_SRC into the destination; FAKE_RCLONE_FAIL=1 fails every command.
import fs from 'node:fs';
import path from 'node:path';

const [cmd, ...args] = process.argv.slice(2);
if (process.env.FAKE_RCLONE_FAIL === '1') {
  process.stderr.write('fake rclone: simulated failure\nsecond line\n');
  process.exit(1);
}
if (process.env.FAKE_RCLONE_LOG) fs.appendFileSync(process.env.FAKE_RCLONE_LOG, `${cmd} ${args.join(' ')}\n`);
if (cmd === 'lsjson') {
  process.stdout.write(fs.readFileSync(process.env.FAKE_RCLONE_LIST, 'utf8'));
} else if (cmd === 'backend' && args[0] === 'copyid') {
  // backend copyid <remote>: <id> <dest-file>; the listing entry with that ID names its content in `_Src`
  const [, , id, dest] = args;
  const list = JSON.parse(fs.readFileSync(process.env.FAKE_RCLONE_LIST, 'utf8'));
  const hit = list.find((x) => x.ID === id && x._Src);
  if (!hit) {
    process.stderr.write(`fake rclone: no file with id ${id}
`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(hit._Src, dest);
} else if (cmd === 'sync') {
  const positional = args.filter((a, i) => !a.startsWith('-') && !/^--(transfers|include)$/.test(String(args[i - 1])));
  const dest = positional[1];
  // like rclone sync: the destination ends up equal to the source (extras are deleted)
  if (process.env.FAKE_RCLONE_SRC) fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  if (process.env.FAKE_RCLONE_SRC) fs.cpSync(process.env.FAKE_RCLONE_SRC, dest, { recursive: true });
} else {
  process.stderr.write(`fake rclone: unknown command ${cmd}\n`);
  process.exit(2);
}
