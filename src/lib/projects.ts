import type { LngLat } from "./geometry";

/** Um talhão salvo, com todos os parâmetros do plano. */
export type Talhao = {
  id: string;
  nome: string;
  field: LngLat[];
  ab: LngLat[];
  spacing: number;
  headland: number;
  overlapPct: number;
  sacasHa: number;
  precoSaca: number;
  litrosHa: number;
  precoLitro: number;
  savedAt: number;
};

/** Uma fazenda contém vários talhões. */
export type Fazenda = {
  id: string;
  nome: string;
  talhoes: Talhao[];
};

const KEY = "agrolinha:fazendas";
const OLD_KEY = "agrolinha:projetos";

export function loadFazendas(): Fazenda[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
    // migra dados antigos (quando cada projeto era 1 talhão solto)
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      const talhoes: Talhao[] = JSON.parse(old);
      if (talhoes.length) {
        const migrada: Fazenda[] = [
          { id: "migrada", nome: "Minha fazenda", talhoes },
        ];
        saveFazendas(migrada);
        return migrada;
      }
    }
    return [];
  } catch {
    return [];
  }
}

export function saveFazendas(list: Fazenda[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

// ---- Nuvem (Supabase) ----
import { supabase } from "./supabase";

export async function loadCloudFazendas(): Promise<Fazenda[] | null> {
  const { data, error } = await supabase
    .from("user_fazendas")
    .select("data")
    .maybeSingle();
  if (error || !data) return null;
  return (data.data as Fazenda[]) ?? [];
}

export async function saveCloudFazendas(userId: string, list: Fazenda[]) {
  await supabase.from("user_fazendas").upsert({
    user_id: userId,
    data: list,
    updated_at: new Date().toISOString(),
  });
}
