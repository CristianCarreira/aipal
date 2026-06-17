const { execFile } = require('child_process');

function shellQuote(value) {
  const escaped = String(value).replace(/'/g, String.raw`'\''`);
  return `'${escaped}'`;
}

function wrapCommandWithPty(command, envKey) {
  if (envKey) {
    const python = `import pty,os; pty.spawn(["bash","-c",os.environ["${envKey}"]])`;
    return `python3 -c ${shellQuote(python)}`;
  }
  const python = 'import pty,sys; pty.spawn(["bash","-c", sys.argv[1]])';
  return `python3 -c ${shellQuote(python)} ${shellQuote(command)}`;
}

function execLocal(cmd, args, options = {}) {
  const { timeout, maxBuffer, onData, ...rest } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { encoding: 'utf8', timeout, maxBuffer, ...rest },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          err.stdout = stdout;
          if (timeout && err.killed) {
            const timeoutErr = new Error(`Command timed out after ${timeout}ms`);
            timeoutErr.code = 'ETIMEDOUT';
            timeoutErr.stderr = stderr;
            timeoutErr.stdout = stdout;
            return reject(timeoutErr);
          }
          return reject(err);
        }
        resolve(stdout || '');
      }
    );
    // Close the child's stdin immediately. execFile leaves stdin as an open
    // pipe; CLIs that read stdin when it is not a TTY (e.g. `codex exec`, which
    // prints "Reading additional input from stdin...") block forever waiting
    // for input that never arrives, then die on the timeout with no output.
    // Sending EOF lets them proceed with just the prompt passed via argv.
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end();
    }
    if (onData && child.stdout) {
      child.stdout.on('data', onData);
    }
    if (onData && child.stderr) {
      child.stderr.on('data', onData);
    }
  });
}

module.exports = {
  execLocal,
  shellQuote,
  wrapCommandWithPty,
};
