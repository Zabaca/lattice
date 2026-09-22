#!/bin/zsh
#
# The five-topic harness: what a research skill does to a real bundle.
#
# It measures a skill, not a function, so every topic is a whole Claude Code
# session (`claude -p "/<skill> <topic>"`) against its own throwaway copy of
# the real Lattice home. What comes back per topic is the session's turns,
# seconds and dollars, the documents it wrote, and `lattice run` over the
# index before and after, which is the only before/after that says whether
# the bundle can now answer the question.
#
# The numbers only mean something like-for-like, so the topics, the flags and
# the probe are fixed here rather than retyped. Two cautions learned by
# running it:
#
#   - Jev's after-completeness is one verdict per topic and moves both ways
#     between identical runs. A 0.5 change is noise, not a result.
#   - A topic already answered by the bundle reads as `answered` or `extend`
#     and writes nothing. That is correct behaviour, not a regression — but
#     it makes that topic incomparable with a round taken before the bundle
#     held the answer.
#
# The real home is never written: only `docs/` and the index are copied out,
# `models/` is symlinked, and the run is bracketed by an md5 of the real
# bundle that must not change.
#
# usage: scripts/research-harness.sh <skill> <tag> [topic-index...]
#   e.g. scripts/research-harness.sh research-jev r        # all five
#        scripts/research-harness.sh research-jev q 4      # one topic
#
# Keys come from the repo's `secrets.yaml` and the OAuth token from
# `~/.claude/settings.json`, which is where a logged-in Claude Code keeps it.
# Output lands in $HARNESS_DIR (default ./tmp/harness, git-ignored).

set -u
repo=${0:a:h:h}
cd $repo

skill=${1:-}
tag=${2:-}
if [[ -z $skill || -z $tag ]]; then
  print -u2 "usage: scripts/research-harness.sh <skill> <tag> [topic-index...]"
  exit 2
fi
shift 2

S=${HARNESS_DIR:-$repo/tmp/harness}
mkdir -p $S/bin

# The skill calls `lattice`, so one has to be on PATH; run this checkout
# rather than whatever is installed globally, which is the whole point.
cat > $S/bin/lattice <<EOF
#!/bin/zsh
exec bun run $repo/src/main.ts "\$@"
EOF
chmod +x $S/bin/lattice
export PATH=$S/bin:$PATH

export TYPESAFE_API_KEY=$(sops -d --extract '["TYPESAFE_API_KEY"]' secrets.yaml)
export EXA_API_KEY=$(sops -d --extract '["EXA_API_KEY"]' secrets.yaml)
export CLAUDE_CODE_OAUTH_TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.claude/settings.json'))['env']['CLAUDE_CODE_OAUTH_TOKEN'])")
# The harness runs the CLI directly and through a skill's Bash tool, which
# does not see the real name; both are needed.
export LATTICE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN
for key in TYPESAFE_API_KEY EXA_API_KEY CLAUDE_CODE_OAUTH_TOKEN; do
  if [[ -z ${(P)key} ]]; then
    print -u2 "$key is empty; the round would measure a failure, not a skill."
    exit 1
  fi
done

topics=(
  "how does SQLite FTS5 rank with bm25 inside a window function"
  "what Exa's deep search type costs and returns"
  "how the Claude Agent SDK's settingSources option affects credentials"
  "reciprocal rank fusion tie handling"
  "how Matryoshka embeddings allow truncation"
)

idx=("$@")
[[ ${#idx} -eq 0 ]] && idx=(1 2 3 4 5)

ls -laR $HOME/.lattice/docs | md5 > $S/realhome-before-$tag.md5
for i in "${idx[@]}"; do
  t=${topics[$i]}
  home=$S/home-$skill-$tag$i
  rm -rf $home; mkdir -p $home
  cp -R $HOME/.lattice/docs $home/docs
  cp $HOME/.lattice/lattice.db* $home/
  ln -s $HOME/.lattice/models $home/models
  export LATTICE_HOME=$home

  # before: what the index alone can answer, with no web and no rewrite, so
  # the probe is the same question every round.
  lattice run "$t" --no-web --max-rewrites 0 --json > $S/before-$skill-$tag$i.json 2>$S/before-$skill-$tag$i.err
  find $home/docs -name '*.md' > $S/files-before-$skill-$tag$i.txt

  out=$S/t-$skill-$tag$i.json
  claude -p "/$skill $t
LATTICE_HOME is already exported in this environment as $home, so the bundle is $home/docs (not ~/.lattice/docs). Run lattice commands plainly, without setting or prefixing any variable." \
    --output-format json --model claude-sonnet-5 --settings '{"autoMemoryEnabled": false}' --max-turns 40 \
    --plugin-dir $repo/plugins/lattice \
    --allowedTools "Bash(lattice:*),Bash(lattice *),Read,Write,Edit,Glob,Grep,Skill,WebSearch,AskUserQuestion" \
    > $out 2>$S/t-$skill-$tag$i.err

  find $home/docs -name '*.md' > $S/files-after-$skill-$tag$i.txt
  newfiles=$(comm -13 <(sort $S/files-before-$skill-$tag$i.txt) <(sort $S/files-after-$skill-$tag$i.txt))
  # An `extend` rewrites a document that was already there, so counting new
  # files alone reports a successful extension as having done nothing.
  changedfiles=$(diff -rq $HOME/.lattice/docs $home/docs 2>/dev/null | awk '/^Files /{print $4}')
  lattice status > $S/status-$skill-$tag$i.txt 2>&1
  lattice run "$t" --no-web --max-rewrites 0 --json > $S/after-$skill-$tag$i.json 2>$S/after-$skill-$tag$i.err

  python3 - "$skill" "$tag$i" "$out" "$S/before-$skill-$tag$i.json" "$S/after-$skill-$tag$i.json" "$newfiles" "$changedfiles" <<'PY'
import json, sys
skill, i, session, before, after, new, changed = sys.argv[1:]


def completeness(path):
    try:
        return f"{json.load(open(path))['completeness']:.2f}"
    except Exception:
        return "?"


try:
    d = json.load(open(session))
except Exception as e:
    print(f"{skill} {i} FAILED {e}")
else:
    def short(paths):
        return [f.rsplit("/docs/", 1)[-1] for f in paths.split()]

    written = short(new)
    extended = [f for f in short(changed) if f not in written]
    print(
        f"{skill} {i} turns={d.get('num_turns')} sec={d.get('duration_ms', 0) / 1000:.1f} "
        f"cost={d.get('total_cost_usd', 0):.3f} err={d.get('is_error')} "
        f"jev={completeness(before)}->{completeness(after)} "
        f"sid={d.get('session_id')} new={written} extended={extended}"
    )
PY
done
ls -laR $HOME/.lattice/docs | md5 > $S/realhome-after-$tag.md5

if diff -q $S/realhome-before-$tag.md5 $S/realhome-after-$tag.md5 >/dev/null; then
  print "real ~/.lattice/docs unchanged"
else
  print -u2 "WARNING: the real bundle changed during the round; the results are suspect."
  exit 1
fi
