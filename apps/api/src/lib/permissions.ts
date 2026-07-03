// Role capabilities. base = read the meal lineup; sous_chef = everything but managing users;
// chef = everything incl. inviting/removing users. isAppAdmin (the app owner) can invite orgs.
export type Role = 'base' | 'sous_chef' | 'chef';

export interface Principal {
  userId: string;
  householdId: string;
  email: string;
  role: Role;
  isAppAdmin: boolean;
}

interface Caps {
  viewPlan: boolean;
  edit: boolean; // recipes, plan, pantry, shopping, substitutions…
  manageUsers: boolean; // invite / remove users in the org
}

const CAPS: Record<Role, Caps> = {
  base: { viewPlan: true, edit: false, manageUsers: false },
  sous_chef: { viewPlan: true, edit: true, manageUsers: false },
  chef: { viewPlan: true, edit: true, manageUsers: true },
};

export function can(p: Principal, cap: keyof Caps): boolean {
  return CAPS[p.role]?.[cap] ?? false;
}

export function isRole(v: string): v is Role {
  return v === 'base' || v === 'sous_chef' || v === 'chef';
}
