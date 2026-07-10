import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../lib/api.js';

// Compact, readable amount from the ingredient's own quantity + unit (e.g. 2 cup, 0.5 tsp).
function amountLabel(qty: number, unit: string): string {
  if (!(qty > 0)) return '';
  const n = Number.isInteger(qty) ? String(qty) : String(Math.round(qty * 100) / 100);
  const u = unit === 'EACH' ? '' : ` ${unit.toLowerCase()}`;
  return `${n}${u}`;
}

// A read-focused "what's in it" view of a recipe: image, per-serving nutrition (with diet-fit
// when the user has a profile), ingredients, and instructions. Used from the Plan board and by
// shared deep links (?recipe=<id>). The Recipes page keeps its own fuller workbench view.

interface DetailIngredient {
  id: string;
  quantity: string | number;
  unit: string;
  freeText: string | null;
  optional?: boolean;
  canonicalItem?: { name: string } | null;
}
interface RecipeDetail {
  id: string;
  name: string;
  servings?: number | null;
  imageUrl?: string | null;
  cuisine?: string | null;
  tags?: string[];
  externalRating?: number | null;
  instructions?: string | null;
  sourceUrl?: string | null;
  ingredients: DetailIngredient[];
  nutrition?: {
    perServing?: Partial<Record<'calories' | 'proteinG' | 'carbsG' | 'fatG' | 'fiberG' | 'sodiumMg', number>>;
    covered?: number;
    required?: number;
  } | null;
}
interface DietTarget {
  targetCalories: number | null;
  proteinG: number | null;
  carbG: number | null;
  fatG: number | null;
}

function shareLink(id: string) {
  return `${window.location.origin}/?recipe=${id}`;
}

export function RecipeDetailModal({
  recipeId,
  onClose,
  footer,
}: {
  recipeId: string;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const [r, setR] = useState<RecipeDetail>();
  const [target, setTarget] = useState<DietTarget | null>(null);
  const [err, setErr] = useState<string>();
  const [shareMsg, setShareMsg] = useState<string>();

  useEffect(() => {
    api.get<RecipeDetail>(`/recipes/${recipeId}`).then(setR).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    api
      .get<{ profile: DietTarget | null }>('/diet-profile')
      .then(({ profile }) => setTarget(profile?.targetCalories ? profile : null))
      .catch(() => {});
  }, [recipeId]);

  async function share() {
    const url = shareLink(recipeId);
    const data = { title: r?.name ?? 'Recipe', text: `Check out ${r?.name ?? 'this recipe'}`, url };
    try {
      if (navigator.share) {
        await navigator.share(data);
        return;
      }
    } catch {
      /* user cancelled share sheet — fall through to copy */
    }
    try {
      await navigator.clipboard.writeText(url);
      setShareMsg('Link copied');
    } catch {
      setShareMsg(url);
    }
  }

  const ps = r?.nutrition?.perServing;
  const cal = ps?.calories;
  const pct = cal && target?.targetCalories ? Math.round((cal / target.targetCalories) * 100) : null;

  return (
    <div className="sheet recipe-detail-sheet">
      <div className="sheet-title recipe-detail-head">
        <span>{r?.name ?? 'Recipe'}</span>
        <button className="chip" onClick={share} title="Share">
          🔗 Share
        </button>
      </div>
      {shareMsg && <p className="notice">{shareMsg}</p>}
      {err && <p className="error">{err}</p>}
      {!r && !err && <p className="muted">Loading…</p>}

      {r && (
        <div className="recipe-detail-body">
          {r.imageUrl && <img className="recipe-detail-img" src={r.imageUrl} alt="" />}

          <div className="recipe-detail-meta muted">
            {r.servings ? `Makes ${r.servings}` : ''}
            {r.cuisine ? ` · ${r.cuisine}` : ''}
            {r.externalRating != null ? ` · ★${r.externalRating.toFixed(1)}` : ''}
          </div>

          {ps && (cal != null) && (
            <div className="recipe-nutrition">
              <div className="recipe-nutrition-cal">
                <strong>{Math.round(cal)}</strong> kcal / serving
                {pct != null && <span className="muted"> · {pct}% of your {target!.targetCalories} target</span>}
              </div>
              <div className="recipe-nutrition-macros muted">
                {ps.proteinG != null && <span>P {Math.round(ps.proteinG)}g</span>}
                {ps.carbsG != null && <span>C {Math.round(ps.carbsG)}g</span>}
                {ps.fatG != null && <span>F {Math.round(ps.fatG)}g</span>}
              </div>
            </div>
          )}

          <div className="section-label">Ingredients</div>
          <ul className="recipe-detail-ings">
            {r.ingredients.map((i) => {
              const name = i.canonicalItem?.name ?? i.freeText ?? 'item';
              const amount = amountLabel(Number(i.quantity), i.unit);
              return (
                <li key={i.id} className={i.optional ? 'muted' : ''}>
                  {amount && <span className="ing-amount">{amount}</span>} {name}
                  {i.optional ? ' (optional)' : ''}
                </li>
              );
            })}
          </ul>

          {r.instructions && (
            <>
              <div className="section-label">Instructions</div>
              <p className="recipe-detail-steps">{r.instructions}</p>
            </>
          )}

          {r.sourceUrl && (
            <a className="btn-link" href={r.sourceUrl} target="_blank" rel="noreferrer">
              Source ↗
            </a>
          )}
        </div>
      )}

      {footer}

      <button className="chip recipe-detail-close" onClick={onClose}>
        close
      </button>
    </div>
  );
}
