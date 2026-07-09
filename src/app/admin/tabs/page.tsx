export default function AdminTabsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[22px] font-semibold tracking-tight">Flipar</h2>
        <p className="text-[13px] text-paper-soft dark:text-ink-soft mt-1">
          Sérsniðnir flipar sem birtast neðst á forsíðunni fyrir tiltekna notendahópa
        </p>
      </div>

      <div className="rounded-xl border border-dashed border-paper-border dark:border-ink-border p-10 text-center text-sm text-paper-faint dark:text-ink-faint">
        Þessi hluti er ekki tilbúinn enn.
        <br />
        <span className="text-[11.5px]">Í næstu útgáfu munt þú geta búið til flipa fyrir sérsniðnar heildir (t.d. „Mín uppáhaldsskjöl“, „Fyrir smíðaverkstjóra“).</span>
      </div>
    </div>
  );
}
