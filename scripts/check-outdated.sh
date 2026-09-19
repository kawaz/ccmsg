#!/usr/bin/env bash
# 直接依存に更新が出ていないか確認する。
# bun outdated は package.json に書いた依存だけを表に出し (推移依存は対象外)、
# 更新があっても registry に到達できなくても終了コードは 0 なので、
# 表の行の有無と registry の到達性をこちらで判定する。
set -euo pipefail

registry_reachable() {
    local dep
    for dep in $(bun -e 'const p = await Bun.file("package.json").json(); console.log([...Object.keys(p.dependencies ?? {}), ...Object.keys(p.devDependencies ?? {})].join("\n"))'); do
        if bun info "$dep" version --no-cache >/dev/null 2>&1; then
            return 0
        fi
    done
    return 1
}

out=$(bun outdated 2>/dev/null)
rows=$(printf '%s\n' "$out" | { grep -E '^\| ' || true; } | { grep -vE '^\| Package ' || true; })

if [[ -n "$rows" ]]; then
    printf '%s\n' "$out"
    printf >&2 '%s\n' 'ERROR: 直接依存に更新があります。"bun update" で追従し (範囲を固定している依存は package.json のバージョンを書き換えてから) 再実行してください'
    exit 1
fi

if ! registry_reachable; then
    echo '⚠ registry に到達できないため直接依存の更新有無は未確認 (通過)'
    exit 0
fi

echo '✓ 直接依存に更新はありません'
