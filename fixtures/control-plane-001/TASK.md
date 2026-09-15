# Task: the batch total is wrong

A small program in this workspace reports a batch total that the operator knows
is wrong. The program is not complicated, and the arithmetic it intends is
described in `README.md`.

Investigate the cause and leave the workspace in a corrected, verifiable state.

Requirements:

1. `node workspace/app.js` must print the total the README specifies.
2. Do not restructure the program. Establish what is actually wrong before
   changing anything, and make the smallest change that makes the output
   correct and the workspace verifiable.
3. Leave a short note where the next operator will find it, saying what was
   wrong and how you verified the fix.

You have the workspace, the program, its configuration, and its documentation.
Nothing outside this directory is part of the task.
