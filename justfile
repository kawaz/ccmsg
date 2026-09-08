# ccmsg
#
# kawaz/* リポの共通テンプレ (kawaz/bump-semver justfile が canonical) に揃えてある。
# 言語依存箇所 (lint/typecheck/test) のみカスタム。VCS 操作と翻訳鮮度チェックは
# bump-semver vcs サブコマンドに委譲する。
# ---------- settings ----------

set unstable
set guards
set lazy
set shell := ["bash", "-eu", "-o", "pipefail", "-c"]
set script-interpreter := ["bash", "-eu", "-o", "pipefail"]

# ---------- variables ----------
# bump-version トリガとなる product code パス。実装 (src/) と、その解釈を左右する
# lock / tsconfig を対象にする。docs/ や *.md / justfile は除外。

bump-trigger-paths := "src/ bun.lock tsconfig.json"

version-files := "package.json"

# ---------- default ----------

# レシピ一覧を表示
default:
    @just --list

# ---------- main entries ----------

# push (バージョン bump 済みを前提、全 gate 通過後に push)
push: check-on-default-branch ensure-clean ci check-translations check-version-bumped
    bump-semver vcs push --branch main --jj-bookmark-auto-advance

# version を bump して Release commit を作成 (push は別途 `just push`)
[script]
bump-version bump="patch": ensure-clean
    new_version=$(bump-semver {{ bump }} {{ version-files }} --write --no-hint)
    bump-semver vcs commit --allow-nonexistent-path -m "Release v${new_version}" {{ version-files }}

# CI 単一エントリ (lint→typecheck→test を依存重複排除で1回ずつ保証)
ci: lint typecheck test

# 現在の version を表示
version:
    @bump-semver get {{ version-files }} --no-hint

# ---------- dev recipes ----------

# lint (justfile フォーマット確認 + oxlint (type-aware) + oxfmt の整形確認)
lint:
    just --fmt --check --unstable
    bun x oxlint
    bun x oxfmt --check

# 型チェック
typecheck: lint
    bun x tsc --noEmit

# テスト (dispatch の認可境界と、属性表を走査する M1 の固定)
test: lint typecheck
    bun test

# ---------- check recipes (push の sanity 検証) ----------

# 現在の bookmark/branch が default (= main) 上にあるか確認
[private]
[script]
check-on-default-branch:
    if ! bump-semver vcs is on-default-branch; then
        bn=$(bump-semver vcs get default-branch)
        printf >&2 "⚠ default branch (%s) に合流してから push してください\n  1. just sync\n  2. just promote\n  3. %s ワークスペースに移動して just push\n" "$bn" "$bn"
        exit 1
    fi

# 現在の worktree を default branch に rebase
sync:
    bump-semver vcs sync --onto $(bump-semver vcs get default-branch)@origin

# default branch を現在の commit に forward (push しない)
promote:
    bump-semver vcs promote

# ワーキングコピーがクリーン (jj は @ が empty、git は porcelain 空)
ensure-clean: lint
    bump-semver vcs is clean

# 翻訳ペア (NAME-ja.md / NAME.md) の整合性チェック
check-translations: ensure-clean check-translation-freshness (_check-translation-headers "README") (_check-translation-headers "docs/DESIGN")

# 翻訳ペアの鮮度: en の最終 commit timestamp >= ja
[private]
check-translation-freshness:
    bump-semver vcs outdated 'glob:**/*-ja.md' '$1/$2.md'

# 相互リンクヘッダの確認 (vcs outdated は timestamp のみ検証するので grep は別途)
[private]
_check-translation-headers name:
    test -f {{ name }}-ja.md
    test -f {{ name }}.md
    head -5 {{ name }}-ja.md | grep -qF "🇬🇧"
    head -5 {{ name }}.md    | grep -qF "🇯🇵"

# product code に変更があれば version も main@origin より bump 済か検証
[private]
[script]
check-version-bumped:
    rc=0
    bump-semver vcs diff -q main@origin -- {{ bump-trigger-paths }} || rc=$?
    case "$rc" in
      0) exit 0 ;;
      1) ;;
      *) echo "ERROR: bump-semver vcs diff failed (rc=$rc). main@origin が track されていない可能性" >&2; exit 1 ;;
    esac
    bump-semver compare gt package.json vcs:main@origin:package.json --no-hint && exit 0
    echo 'ERROR: bump-trigger-paths が変わってるが version 未 bump。"just bump-version" を実行してください' >&2
    exit 1
