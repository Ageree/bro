"""Boot: run one kit command in the task sandbox (`runKit`, agent/lib/sandbox/kit.ts).

Runs as `python3 -I -c "import os;exec(os.environ['BROKIT_BOOT'])"` with
BROKIT_HOME (/workspace/.bro), BROKIT_EXPECT (the kit version) and
BROKIT_ARGS (a JSON list of the command's words): the arguments never pass
through a shell. Exits 3 when the kit there is missing or another version
(the hook did not run, a release came mid-turn): `runKit` then delivers it
and asks again. Otherwise it is `brokit <args>`, as the model's own wrapper
bin/brokit runs it.
"""

import json
import os
import sys


def main():
    kit = os.path.join(os.environ["BROKIT_HOME"], "kit")
    try:
        with open(os.path.join(kit, "VERSION"), encoding="utf-8") as handle:
            version = handle.read().strip()
    except OSError:
        version = None
    if version != os.environ["BROKIT_EXPECT"]:
        sys.stderr.write("brokit: the kit in this sandbox is missing or stale\n")
        sys.exit(3)
    args = json.loads(os.environ["BROKIT_ARGS"])
    if not (isinstance(args, list) and all(isinstance(arg, str) for arg in args)):
        sys.stderr.write("brokit: BROKIT_ARGS is not a list of strings\n")
        sys.exit(1)
    sys.path.insert(0, kit)
    from brokit.cli import main as brokit

    sys.exit(brokit(args))


if __name__ == "__main__":
    main()
