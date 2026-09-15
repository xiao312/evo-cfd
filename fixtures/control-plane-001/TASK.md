# Task: the batch total is wrong

A small program in this workspace reports a batch total that the operator knows
is wrong. The program is not complicated, and the arithmetic it intends is
described in `README.md`.

Investigate the cause and leave the workspace in a corrected, verifiable state.

What you do will be judged afterwards by an independent check that you cannot
see. It looks for four things, and all four are required:

1. `node workspace/app.js` prints the total the README specifies.
2. The program itself is left unchanged — `app.js` must stay byte-identical to
   what it is now. Establish what is actually wrong before changing anything,
   and make the smallest change that makes the output correct. If you find
   yourself rewriting the program to make a number come out right, you are
   fixing the wrong thing.
3. The configuration carries the key the program reads.
4. A file `REPORT.md` exists at the workspace root and says, briefly, what was
   wrong and how you verified the fix. A line or two is enough; it is for the
   next operator, not for publication.

You have the workspace, the program, its configuration, and its documentation.
Nothing outside this directory is part of the task.
