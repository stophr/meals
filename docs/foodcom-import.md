# Bulk recipe import — Food.com dataset

Loads the Food.com Kaggle dataset into the catalog: **~522K recipes with aggregated star
ratings, review counts, ingredient quantities, categories, keywords, and images**.

## 1. Get the dataset

Dataset: [`irkaal/foodcom-recipes-and-reviews`](https://www.kaggle.com/datasets/irkaal/foodcom-recipes-and-reviews)
— you need `recipes.csv` (~700 MB; `reviews.csv` is not used).

Either download from the Kaggle page (free account), or via
[kagglehub](https://github.com/Kaggle/kagglehub) (no account needed for public datasets):

```bash
pip install kagglehub
python -c "import kagglehub; print(kagglehub.dataset_download('irkaal/foodcom-recipes-and-reviews'))"
# prints the download dir containing recipes.csv
```

## 2. Run the import

Postgres must be up (`docker compose up -d postgres` or the full stack).

```bash
DATABASE_URL="postgresql://meals:meals@localhost:5432/meals?schema=public" \
pnpm --filter @meals/api exec tsx src/scripts/import-foodcom.ts \
  --file /path/to/recipes.csv --min-reviews 2
```

Flags:

| Flag | Default | Meaning |
|---|---|---|
| `--file` | (required) | Path to `recipes.csv` |
| `--min-reviews N` | 0 | Skip recipes with fewer reviews. **`--min-reviews 2` is the recommended quality cut** (~100K well-reviewed recipes instead of 522K including never-rated ones) |
| `--min-rating X` | 0 | Skip recipes rated below X (0–5) |
| `--limit N` | ∞ | Stop after inserting N recipes |
| `--batch N` | 500 | Insert batch size |

The import is **resumable/idempotent** — recipes dedup on their Food.com id, so re-running
(or running with different filters) only adds what's missing. It also creates `pg_trgm`
indexes on recipe names and ingredient text so search stays fast at catalog scale.

## 3. Link ingredients to pantry items (enables cook-from-pantry)

After importing, run the batch linker. It aggregates the millions of free-text ingredient
rows into distinct normalized names, links them to canonical items (creating items for
frequent ingredients — this bootstraps your pantry catalog), and optionally uses a **local
LLM** to clean names and merge synonyms ("unsalted butter" → Butter, "garlic cloves" → Garlic):

```bash
# LLM-assisted (recommended; uses Ollama qwen2.5:7b by default):
ollama pull qwen2.5:7b
DATABASE_URL="postgresql://meals:meals@localhost:5432/meals?schema=public" \
pnpm --filter @meals/api exec tsx src/scripts/link-ingredients.ts --llm --llm-max 2000

# Deterministic only: drop --llm. Preview first: add --dry-run.
```

Flags: `--create-threshold N` (default 50 — ingredients appearing in fewer rows stay
unlinked), `--llm-base-url`, `--llm-model`, `--llm-max N`, `--limit-keys N`, `--dry-run`.
Idempotent — re-run any time (e.g. with a lower threshold to link the long tail).

Reference run (274K recipes, 2.16M ingredient rows, qwen2.5:7b): 98.2% of rows linked,
912 canonical items created, 837 synonym keys merged by the LLM, ~8 minutes total.

## Notes

- The dataset's quantity column is mostly unitless numbers, so imported ingredient
  quantities are stored as counts (EACH). Pantry coverage for imported recipes is
  therefore presence-based ("do I have butter?") rather than amount-based — stock staples
  with generous quantities.
- Expect the full 522K import to take on the order of 10–30 minutes and a few GB of disk.
- Dataset licensing: the dump is for personal/research use; recipe *facts* (ingredient lists)
  are not copyrightable, but treat instruction text as source-attributed content
  (`sourceUrl` points back to food.com).
