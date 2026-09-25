set -eu
workspaces=$(npm pkg get name version private --workspaces --include-workspace-root=false --json)
unpublished=$(WORKSPACES="$workspaces" node --input-type=module <<'JS'
const packages = JSON.parse(process.env.WORKSPACES);
for (const { name, version, private: isPrivate } of Object.values(packages)) {
    if (isPrivate) continue;
    if (typeof name !== "string" || typeof version !== "string") throw new Error("Invalid workspace package");
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, { method: "HEAD" });
    if (response.status === 404) console.log(name);
    else if (response.ok) console.error(`Skipping ${name}@${version}: already published`);
    else throw new Error(`Registry check failed for ${name}@${version}: HTTP ${response.status}`);
}
JS
)
if [ -z "$unpublished" ]; then
    echo 'All workspace versions are already published.'
    exit 0
fi
authrc=$(mktemp)
trap 'rm -f "$authrc"' EXIT
printf '%s\n' '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}' > "$authrc"
npm whoami --userconfig "$authrc"
for workspace in $unpublished; do
    npm publish --workspace "$workspace" --access public --dry-run --userconfig "$authrc"
    npm publish --workspace "$workspace" --access public --userconfig "$authrc"
done
