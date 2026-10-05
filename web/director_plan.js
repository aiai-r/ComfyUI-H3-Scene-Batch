export function readPlan(text) {
  const plan = JSON.parse(text);
  if (!plan || !Array.isArray(plan.shots) || !plan.shots.length) {
    throw new Error("shots 配列を持つContext-Loop Plan JSONを指定してください。");
  }
  for (const [index, shot] of plan.shots.entries()) {
    if (!shot || Array.isArray(shot) || typeof shot !== "object") throw new Error(`カット${index + 1}の形式が不正です。`);
    for (const key of ["seed", "prompt_seed"]) {
      if (typeof shot[key] === "number" && !Number.isSafeInteger(shot[key])) {
        throw new Error(`カット${index + 1}の${key}は精度を保つため引用符で囲んだ文字列にしてください。`);
      }
    }
  }
  return plan;
}

export function updateCut(original, fields) {
  const cut = { ...original, id: fields.id, prompt: fields.prompt };
  // Keep explicit frame counts on imported plans until the user changes seconds.
  const previousSeconds = original.duration_seconds == null ? "" : String(original.duration_seconds);
  if (fields.seconds !== previousSeconds) {
    if (!fields.seconds.trim()) delete cut.duration_seconds;
    else {
      const seconds = Number(fields.seconds);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("生成秒数は正の数を指定してください。");
      cut.duration_seconds = seconds;
      delete cut.length;
    }
  }
  if (!fields.seed.trim()) delete cut.seed;
  else {
    if (!/^\d+$/.test(fields.seed) || BigInt(fields.seed) > 18446744073709551615n) throw new Error("seedは0〜18446744073709551615の整数を指定してください。");
    if (fields.seed !== String(original.seed ?? "")) cut.seed = fields.seed;
  }
  return cut;
}
