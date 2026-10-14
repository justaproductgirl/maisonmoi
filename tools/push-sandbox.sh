#!/bin/zsh
# Puts the code you have right now on https://sandbox.maisonmoi.app (repo justaproductgirl/maisonmoi-sandbox).
# Production (maisonmoi.app) only changes with a normal `git push origin main`.
#
# The sandbox copy gets its own CNAME and a robots.txt that keeps search engines out. Those changes live only in
# a throwaway commit pushed to the sandbox repo, never in your history here.
set -e
cd "$(dirname "$0")/.."
KEY=~/.ssh/maisonmoi_sandbox_deploy
REMOTE=git@github.com:justaproductgirl/maisonmoi-sandbox.git

[[ -f $KEY ]] || { echo "Missing $KEY (the sandbox push key)."; exit 1; }
[[ -z $(git status --porcelain --untracked-files=no) ]] || echo "Note: uncommitted changes are NOT included. Commit them first to see them on the sandbox."

export GIT_INDEX_FILE=$(mktemp -u)
trap 'rm -f "$GIT_INDEX_FILE"' EXIT
git read-tree HEAD
git update-index --add --cacheinfo 100644,$(echo sandbox.maisonmoi.app | git hash-object -w --stdin),CNAME
git update-index --add --cacheinfo 100644,$(printf 'User-agent: *\nDisallow: /\n' | git hash-object -w --stdin),robots.txt
commit=$(git commit-tree $(git write-tree) -p HEAD -m "Sandbox build of $(git rev-parse --short HEAD)")

git -c core.sshCommand="ssh -F /dev/null -i $KEY -o IdentitiesOnly=yes -o IdentityAgent=none" push -f -q $REMOTE "${commit}:refs/heads/main"
echo "Sandbox updated with $(git log -1 --format='%h %s' HEAD). Live at https://sandbox.maisonmoi.app in about a minute."
