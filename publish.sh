authrc=$(mktemp)
printf '%s\n' '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}' > "$authrc"
npm whoami --userconfig "$authrc"
npm publish --workspaces --access public --dry-run --userconfig "$authrc"
npm publish --workspaces --access public --userconfig "$authrc"
rm -f "$authrc"
