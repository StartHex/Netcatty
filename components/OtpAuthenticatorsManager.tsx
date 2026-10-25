import {
  Clock,
  Copy,
  KeyRound,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import {
  buildOtpAuthenticatorUri,
  clearOtpAuthenticatorReferences,
  countOtpAuthenticatorReferences,
  rematerializeHostsForAuthenticator,
  sanitizeOtpAuthenticators,
  sortOtpAuthenticators,
  validateOtpAuthenticatorDraft,
  OTP_ALGORITHMS,
  OTP_DIGITS,
} from "../domain/otpAuthenticator";
import type { Host, OtpAuthenticator } from "../types";
import { netcattyBridge } from "@/infrastructure/services/netcattyBridge.ts";
import { cn } from "../lib/utils";
import {
  AsidePanel,
  AsidePanelContent,
  AsidePanelFooter,
} from "./ui/aside-panel";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { toast } from "./ui/toast";
import {
  VaultHeaderSearch,
  VaultPageHeader,
  vaultHeaderIconButtonClass,
  vaultHeaderSecondaryButtonClass,
  vaultSectionTitleClass,
} from "./vault/VaultPageHeader";
import { SystemPanelConfirmDialog } from "./systemManager/SystemPanelConfirmDialog";

interface OtpAuthenticatorsManagerProps {
  authenticators: OtpAuthenticator[];
  hosts: Host[];
  onUpdateAuthenticators: (next: OtpAuthenticator[]) => void;
  onUpdateHosts: (hosts: Host[] | ((prev: Host[]) => Host[])) => void;
}

const DRAFT_ERROR_KEYS: Record<string, string> = {
  label: "otpAuthenticators.error.label",
  secret: "otpAuthenticators.error.secret",
  algorithm: "otpAuthenticators.error.algorithm",
  digits: "otpAuthenticators.error.digits",
  period: "otpAuthenticators.error.period",
  type: "otpAuthenticators.error.type",
};

const createDraft = (): OtpAuthenticator => ({
  id: crypto.randomUUID(),
  label: "",
  type: "totp",
  secret: "",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

type LiveCode = { code: string; secondsRemaining: number };

const useAuthenticatorCode = (authenticator: OtpAuthenticator | null): LiveCode | null => {
  const [live, setLive] = useState<LiveCode | null>(null);
  const endsAtRef = useRef(0);
  const uri = authenticator?.secret ? buildOtpAuthenticatorUri(authenticator) : null;

  useEffect(() => {
    setLive(null);
    endsAtRef.current = 0;
    if (!uri) return undefined;
    const bridge = netcattyBridge.get();
    if (!bridge?.previewTotp) return undefined;
    let cancelled = false;
    let refreshing = false;
    const request = () => {
      refreshing = true;
      void bridge.previewTotp?.({ uri }).then((result) => {
        refreshing = false;
        if (cancelled || !result?.ok || !result.code) return;
        endsAtRef.current = Date.now() + (result.secondsRemaining ?? result.period ?? 30) * 1000;
        setLive({
          code: result.code,
          secondsRemaining: result.secondsRemaining ?? result.period ?? 30,
        });
      }).catch(() => {
        refreshing = false;
      });
    };
    request();
    const timer = setInterval(() => {
      if (cancelled) return;
      const left = Math.max(0, Math.ceil((endsAtRef.current - Date.now()) / 1000));
      setLive((prev) => (prev ? { ...prev, secondsRemaining: left } : prev));
      if (left === 0 && !refreshing) request();
    }, 500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [uri]);

  return live;
};

export const OtpAuthenticatorsManager: React.FC<OtpAuthenticatorsManagerProps> = ({
  authenticators,
  hosts,
  onUpdateAuthenticators,
  onUpdateHosts,
}) => {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<OtpAuthenticator | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OtpAuthenticator | null>(null);

  const ordered = useMemo(
    () => sortOtpAuthenticators(sanitizeOtpAuthenticators(authenticators)),
    [authenticators],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((entry) =>
      entry.label.toLowerCase().includes(q)
      || (entry.issuer ?? "").toLowerCase().includes(q)
      || (entry.account ?? "").toLowerCase().includes(q));
  }, [ordered, search]);

  const referenceCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of ordered) {
      map.set(entry.id, countOtpAuthenticatorReferences(hosts, entry.id));
    }
    return map;
  }, [hosts, ordered]);

  const draftCode = useAuthenticatorCode(draft);

  const openCreate = () => setDraft(createDraft());
  const openEdit = (entry: OtpAuthenticator) => setDraft({ ...entry });
  const closeDraft = () => setDraft(null);

  const saveDraft = () => {
    if (!draft) return;
    const validation = validateOtpAuthenticatorDraft({ ...draft, secret: draft.secret ?? '' });
    if (!validation.ok) {
      const first = validation.errors[0] ?? 'secret';
      toast.error(t(DRAFT_ERROR_KEYS[first]));
      return;
    }
    const now = Date.now();
    const saved: OtpAuthenticator = {
      ...draft,
      label: draft.label.trim(),
      type: "totp",
      secret: draft.secret?.replace(/\s+/g, "").toUpperCase(),
      updatedAt: now,
    };
    const existing = ordered.some((entry) => entry.id === saved.id);
    const next = existing
      ? ordered.map((entry) => (entry.id === saved.id ? saved : entry))
      : [...ordered, saved];
    onUpdateAuthenticators(next);
    if (existing) {
      onUpdateHosts(rematerializeHostsForAuthenticator(hosts, saved));
    }
    setDraft(null);
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    onUpdateAuthenticators(ordered.filter((entry) => entry.id !== deleteTarget.id));
    onUpdateHosts(clearOtpAuthenticatorReferences(hosts, deleteTarget.id));
    if (draft?.id === deleteTarget.id) setDraft(null);
    setDeleteTarget(null);
  };

  const copyCode = async (entry: OtpAuthenticator) => {
    if (!entry.secret) return;
    const bridge = netcattyBridge.get();
    if (!bridge?.previewTotp) {
      toast.error(t("hostDetails.totp.error.unavailable"));
      return;
    }
    const result = await bridge.previewTotp({ uri: buildOtpAuthenticatorUri(entry) });
    if (!result?.ok || !result.code) {
      toast.error(t("hostDetails.totp.error.invalid"));
      return;
    }
    try {
      await navigator.clipboard.writeText(result.code);
      toast.success(t("otpAuthenticators.copied"));
    } catch {
      toast.error(t("otpAuthenticators.copyFailed"));
    }
  };

  const draftMissingSecret = Boolean(draft && ordered.some((entry) => entry.id === draft.id) && !draft.secret);

  return (
    <div className="h-full flex relative">
      <div className={cn("flex-1 flex flex-col min-h-0 transition-all duration-200", draft && "mr-[380px]")}>
        <VaultPageHeader>
          <Button onClick={openCreate} variant="secondary" className={vaultHeaderSecondaryButtonClass}>
            <Plus size={14} />
            {t("otpAuthenticators.action.add")}
          </Button>
          <div className="ml-auto flex items-center gap-2 min-w-0 flex-shrink">
            <VaultHeaderSearch
              aria-label={t("otpAuthenticators.search.placeholder")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("otpAuthenticators.search.placeholder")}
              className="flex-shrink w-64"
            />
          </div>
        </VaultPageHeader>

        <div className="flex-1 overflow-y-auto">
          <div className="space-y-3 p-3">
            <div className="flex items-center justify-between">
              <h2 className={vaultSectionTitleClass}>{t("otpAuthenticators.sectionTitle")}</h2>
              <span className="text-xs text-muted-foreground">
                {t("otpAuthenticators.count", { count: filtered.length })}
              </span>
            </div>

            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center mb-4">
                  <ShieldCheck size={32} className="opacity-60" />
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">
                  {t("otpAuthenticators.empty.title")}
                </h3>
                <p className="text-sm text-center max-w-sm mb-4">{t("otpAuthenticators.empty.desc")}</p>
                <Button onClick={openCreate}>
                  <Plus size={14} className="mr-2" />
                  {t("otpAuthenticators.action.add")}
                </Button>
              </div>
            ) : (
              <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filtered.map((entry) => (
                  <div
                    key={entry.id}
                    className={cn(
                      "soft-card elevate rounded-xl px-3 py-2 group",
                      draft?.id === entry.id && "ring-2 ring-primary",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className="h-9 w-9 shrink-0 rounded-lg bg-secondary/80 flex items-center justify-center">
                        <KeyRound size={18} className="text-muted-foreground" />
                      </div>
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left focus-visible:outline-none"
                        onClick={() => openEdit(entry)}
                      >
                        <div className="text-sm font-semibold truncate">{entry.label}</div>
                        <div className="text-[11px] font-mono text-muted-foreground truncate">
                          {entry.algorithm} · {entry.digits} {t("otpAuthenticators.field.digitsShort")} · {entry.period}s
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate">
                          {t("otpAuthenticators.usage", { count: referenceCounts.get(entry.id) ?? 0 })}
                        </div>
                      </button>
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                          <Button
                            variant="ghost"
                            size="icon"
                            className={vaultHeaderIconButtonClass}
                            aria-label={t("otpAuthenticators.action.copyCode")}
                            onClick={() => { void copyCode(entry); }}
                            disabled={!entry.secret}
                          >
                            <Copy size={14} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className={vaultHeaderIconButtonClass}
                            aria-label={t("action.edit")}
                            onClick={() => openEdit(entry)}
                          >
                            <Pencil size={14} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn(vaultHeaderIconButtonClass, "text-destructive")}
                            aria-label={t("action.delete")}
                            onClick={() => setDeleteTarget(entry)}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                        {!entry.secret && (
                          <span className="text-[10px] text-destructive">{t("otpAuthenticators.missingSecret")}</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {draft && (
        <AsidePanel
          open={true}
          onClose={closeDraft}
          title={draft.label || t("otpAuthenticators.panel.newTitle")}
        >
          <AsidePanelContent>
            <Card className="p-3 space-y-3 bg-card border-border/80">
              <div className="space-y-2">
                <Label htmlFor="otp-auth-label">{t("otpAuthenticators.field.label")}</Label>
                <Input
                  id="otp-auth-label"
                  value={draft.label}
                  onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                  placeholder={t("otpAuthenticators.field.labelPlaceholder")}
                  className="h-9"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="otp-auth-secret">{t("otpAuthenticators.field.secret")}</Label>
                <Input
                  id="otp-auth-secret"
                  value={draft.secret ?? ""}
                  onChange={(event) => setDraft({ ...draft, secret: event.target.value })}
                  placeholder={draftMissingSecret ? t("otpAuthenticators.field.secretMissing") : t("hostDetails.totp.secretPlaceholder")}
                  className="h-9 font-mono text-xs"
                  spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">{t("otpAuthenticators.field.secretHint")}</p>
              </div>
            </Card>

            <Card className="p-3 space-y-3 bg-card border-border/80">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>{t("otpAuthenticators.field.type")}</Label>
                  <Select value="totp" disabled>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="totp">TOTP</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t("otpAuthenticators.field.algorithm")}</Label>
                  <Select
                    value={draft.algorithm}
                    onValueChange={(value) => setDraft({ ...draft, algorithm: value as OtpAuthenticator["algorithm"] })}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OTP_ALGORITHMS.map((algorithm) => (
                        <SelectItem key={algorithm} value={algorithm}>{algorithm}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t("otpAuthenticators.field.digits")}</Label>
                  <Select
                    value={String(draft.digits)}
                    onValueChange={(value) => setDraft({ ...draft, digits: Number(value) as OtpAuthenticator["digits"] })}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OTP_DIGITS.map((digits) => (
                        <SelectItem key={digits} value={String(digits)}>{digits}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="otp-auth-period">{t("otpAuthenticators.field.period")}</Label>
                  <Input
                    id="otp-auth-period"
                    type="number"
                    min={1}
                    max={300}
                    value={draft.period}
                    onChange={(event) => setDraft({ ...draft, period: Number(event.target.value) })}
                    className="h-9"
                  />
                </div>
              </div>
            </Card>

            <Card className="p-3 space-y-2 bg-card border-border/80">
              <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                <Clock size={14} />
                {t("otpAuthenticators.preview")}
              </div>
              {draftCode ? (
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-lg tracking-[0.2em] tabular-nums">{draftCode.code}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("otpAuthenticators.previewCountdown", { seconds: draftCode.secondsRemaining })}
                  </span>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("otpAuthenticators.previewEmpty")}</p>
              )}
            </Card>
          </AsidePanelContent>
          <AsidePanelFooter className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={closeDraft}>
              {t("common.cancel")}
            </Button>
            <Button className="flex-1" onClick={saveDraft}>
              {t("common.save")}
            </Button>
          </AsidePanelFooter>
        </AsidePanel>
      )}

      {deleteTarget && (
        <SystemPanelConfirmDialog
          open
          destructive
          title={t("otpAuthenticators.delete.title")}
          message={t("otpAuthenticators.delete.message", {
            name: deleteTarget.label,
            count: referenceCounts.get(deleteTarget.id) ?? 0,
          })}
          confirmLabel={t("action.delete")}
          onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
};

export default OtpAuthenticatorsManager;
