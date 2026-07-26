import { Modal } from "bootstrap";
import type { FleetStore, OperatorAccessRecord, OrgMember, OrgSummary } from "../data/store";
import type { OrgRole } from "../domain/types";
import type { OperatorRole } from "@kioskoscope/domain";
import { PERMISSION_MATRIX, ROLE_HINTS, ROLE_LABELS, ROLE_ORDER } from "../domain/roles";
import { el, icon, toast } from "./dom";
import { MODULES, SUBSCRIPTION_TYPES } from "../domain/modules";
import { orgStyleSettingsTab } from "./orgStyleSettings";

// Menu Organisation (hub à onglets, patterns SaaS classiques) : Général, Membres,
// Invitations, Rôles & permissions, Kiosks, Mes styles, Paiement. La gestion (écriture) est
// réservée au super_user (aligné sur la RLS 0006) ; les autres voient en lecture.

type Tab = "general" | "members" | "invites" | "roles" | "booths" | "styles" | "access" | "billing" | "subscription";
// `adminOnly` : onglet de pilotage PLATEFORME (l'org le subit, ne le règle pas). Masqué —
// pas grisé — hors global_admin : un client n'a pas à savoir qu'un écran d'attribution existe.
const TABS: ReadonlyArray<{ key: Tab; label: string; adminOnly?: boolean }> = [
  { key: "general", label: "Général" },
  { key: "members", label: "Membres" },
  { key: "invites", label: "Invitations" },
  { key: "roles", label: "Rôles & permissions" },
  { key: "booths", label: "Kiosks" },
  { key: "styles", label: "Mes styles" },
  { key: "access", label: "Accès opérateur" },
  { key: "billing", label: "Paiement" },
  { key: "subscription", label: "Souscription & modules", adminOnly: true },
];

/** Rôles attribuables à un accès opérateur cabine (global_admin = plateforme, non créé ici). */
export const OPERATOR_ROLE_LABELS: Record<OperatorRole, string> = {
  operator: "Opérateur",
  super_user: "Administrateur",
  global_admin: "Admin global",
};

/**
 * PIN aléatoire (défaut 6 chiffres) via WebCrypto. Généré côté back-office et affiché une
 * seule fois : ni l'admin ni personne ne « choisit » un PIN faible, et il n'est jamais
 * réaffiché ensuite (seule l'empreinte est stockée). Biais modulo négligeable pour cet usage.
 */
function randomPin(len = 6): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => String(b % 10)).join("");
}

/** Slug identifiant (CIN-076) : sans accents, alphanumérique majuscule, borné. */
function slugify(s: string, max = 12): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, max);
}

/** Code de rôle par défaut pour le suffixe auto (CIN-076). */
const ROLE_SUFFIX: Record<OperatorRole, string> = {
  operator: "OP",
  super_user: "ADMIN",
  global_admin: "GADMIN",
};

/**
 * Hub d'administration d'UNE organisation.
 *
 * `targetOrgId` (CIN-091 b) : org à ouvrir d'emblée, quand on arrive depuis le roster
 * « Organisations » en cliquant un client. Sans lui, on retombe sur l'org active du compte —
 * le cas de l'opérateur, qui n'administre que la sienne. Le global_admin n'a PAS d'org active
 * (`activeOrganizationId: null`) : c'est précisément ce paramètre qui lui donne un contexte.
 */
export function settingsPage(
  store: FleetStore,
  onChanged: () => void,
  targetOrgId: string | null = null,
  onBack?: () => void,
): HTMLElement {
  const orgs = store.organizations();
  // On ne fait confiance à `targetOrgId` que s'il désigne une org réellement visible : un id
  // périmé (org supprimée entre-temps) ne doit pas produire une page vide et muette.
  const target = targetOrgId && orgs.some((o) => o.id === targetOrgId) ? targetOrgId : null;
  const state = {
    tab: "general" as Tab,
    orgId: target ?? store.current?.activeOrganizationId ?? orgs[0]?.id ?? null,
  };

  const container = el("div", {}, []);
  const render = (): void => {
    const org = orgs.find((o) => o.id === state.orgId) ?? null;
    const canManage = store.canManageOrg(state.orgId);

    // Sélecteur d'org (global_admin gère plusieurs orgs).
    const orgPicker =
      store.isGlobalAdmin && orgs.length > 0
        ? (() => {
            const sel = el("select", { class: "form-select w-auto" }, orgs.map((o) => el("option", { value: o.id, ...(o.id === state.orgId ? { selected: "selected" } : {}) }, [o.name]))) as HTMLSelectElement;
            sel.addEventListener("change", () => {
              state.orgId = sel.value;
              render();
            });
            return el("div", { class: "ms-auto d-flex align-items-center gap-2" }, [el("span", { class: "text-secondary" }, ["Organisation :"]), sel]);
          })()
        : el("span", {}, []);

    // Onglet « Mes styles » grisé + cadenas si le module personalization n'est pas accordé
    // (upsell) — sauf pour le global_admin. Reste cliquable : le corps affiche l'upsell.
    const stylesGated = org ? !store.hasModule(org.id, "personalization") && !store.isGlobalAdmin : false;
    const lockPath = "M6 11V7a4 4 0 0 1 8 0v4M5 11h10a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1H5a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1z";

    const visibleTabs = TABS.filter((t) => !t.adminOnly || store.isGlobalAdmin);
    const tabsNav = el(
      "ul",
      { class: "nav nav-tabs mb-3" },
      visibleTabs.map((t) => {
        const gated = t.key === "styles" && stylesGated;
        const children: Array<Node | string> = [t.label];
        if (gated) children.push(el("span", { class: "ms-1 text-secondary" }, [icon(lockPath, 14)]));
        const link = el("a", { class: `nav-link ${state.tab === t.key ? "active" : ""} ${gated ? "opacity-75" : ""}`, href: "#", ...(gated ? { title: "Module non inclus dans votre offre" } : {}) }, children);
        link.addEventListener("click", (e) => {
          e.preventDefault();
          state.tab = t.key;
          render();
        });
        return el("li", { class: "nav-item" }, [link]);
      }),
    );

    const body = el("div", {}, [tabRenderers[state.tab](store, org, canManage, onChanged)]);
    if (!canManage && (state.tab === "general" || state.tab === "members" || state.tab === "invites" || state.tab === "access" || state.tab === "billing")) {
      body.prepend(el("div", { class: "alert alert-secondary" }, ["Lecture seule — seul un super-utilisateur de l'organisation peut modifier ces réglages."]));
    }

    // Arrivé depuis le roster « Organisations » : la page administre le client DÉSIGNÉ, pas la
    // sienne. Le titre porte donc son nom, et un retour explicite ramène au roster — sans quoi
    // on se retrouve « dans une org » sans savoir comment en sortir (ambiguïté visée par CIN-091).
    const fromRoster = target !== null && onBack !== undefined;
    const backLink = (() => {
      if (!fromRoster) return el("span", {}, []);
      const b = el("button", { class: "btn btn-link p-0 mb-1 d-inline-flex align-items-center gap-1", type: "button" }, [
        icon("M15 6l-6 6l6 6", 16),
        "Organisations",
      ]);
      b.addEventListener("click", () => onBack!());
      return b;
    })();

    container.replaceChildren(
      el("div", { class: "d-flex align-items-center mb-3 gap-2 flex-wrap" }, [
        el("div", {}, [
          backLink,
          el("h2", { class: "page-title m-0" }, [fromRoster && org ? org.name : "Mon organisation"]),
          el("div", { class: "text-secondary" }, [
            fromRoster ? "Administration de l'organisation (super-admin)" : org ? org.name : "Aucune organisation",
          ]),
        ]),
        orgPicker,
      ]),
      org ? el("div", {}, [tabsNav, body]) : el("div", { class: "card" }, [el("div", { class: "card-body text-secondary" }, ["Aucune organisation à gérer."])]),
    );
  };

  render();
  return container;
}

// ── Onglet Général ────────────────────────────────────────────────────────────
function generalTab(store: FleetStore, org: OrgSummary | null, canManage: boolean, onChanged: () => void): HTMLElement {
  if (!org) return el("span", {}, []);
  const dis = canManage ? {} : { disabled: "true" };
  const name = el("input", { class: "form-control", type: "text", value: org.name, ...dis }) as HTMLInputElement;
  const type = el("select", { class: "form-select", ...dis }, (["bar", "festival", "event"] as const).map((t) => el("option", { value: t, ...(t === org.type ? { selected: "selected" } : {}) }, [t]))) as HTMLSelectElement;
  const region = el("input", { class: "form-control", type: "text", value: org.region ?? "", placeholder: "FR, BE…", ...dis }) as HTMLInputElement;
  const currency = el("input", { class: "form-control", type: "text", value: org.currency, maxlength: "3", ...dis }) as HTMLInputElement;
  const whitelist = el("input", { class: "form-control", type: "text", value: org.whitelistTags.join(", "), placeholder: "bar, 18+, enfant…", ...dis }) as HTMLInputElement;
  const theme = el("input", { class: "form-control", type: "text", value: org.themeId ?? "", placeholder: "id de thème (optionnel)", ...dis }) as HTMLInputElement;

  const field = (label: string, hint: string, input: HTMLElement): HTMLElement =>
    el("div", { class: "col-md-6 mb-3" }, [el("label", { class: "form-label" }, [label]), input, el("div", { class: "form-hint" }, [hint])]);

  const status = el("div", { class: "small" }, []);
  const save = el("button", { class: "btn btn-primary", type: "button", ...dis }, ["Enregistrer"]);
  save.addEventListener("click", () => {
    status.className = "small text-secondary";
    status.textContent = "Enregistrement…";
    void store
      .updateOrganization(org.id, {
        name: name.value.trim(),
        type: type.value,
        region: region.value.trim() || null,
        currency: (currency.value.trim() || "EUR").toUpperCase(),
        whitelistTags: whitelist.value.split(",").map((t) => t.trim()).filter(Boolean),
        themeId: theme.value.trim() || null,
      })
      .then((res) => {
        if (res.ok) {
          status.className = "small text-green";
          status.textContent = "Enregistré ✓";
          onChanged();
        } else {
          status.className = "small text-danger";
          status.textContent = res.error ?? "Échec.";
        }
      });
  });

  return el("div", { class: "card" }, [
    el("div", { class: "card-body" }, [
      el("div", { class: "row" }, [
        field("Nom", "Nom affiché de l'organisation.", name),
        field("Type d'organisation", "Nature de l'organisation (bar, festival, événement…). La catégorie du LIEU est réglée sur chaque Kiosk.", type),
        field("Région", "1 organisation = 1 région (code libre).", region),
        field("Devise", "ISO-4217 (EUR, GBP…). Pilote le formatage monétaire.", currency),
        field("Whitelist (tags d'audience)", "Médias non conformes exclus des Kiosks.", whitelist),
        field("Thème", "Identifiant de thème UI (optionnel).", theme),
      ]),
      canManage ? el("div", { class: "d-flex align-items-center gap-3" }, [save, status]) : el("span", {}, []),
    ]),
  ]);
}

// ── Onglet Souscription & modules (super-admin) ───────────────────────────────
// Pendant UNITAIRE des actions par lot du roster « Organisations » : ici on règle UNE org, en
// voyant son état courant. L'écriture est refusée à quiconque n'est pas global_admin par la RLS
// (0011) — le masquage de l'onglet n'est que la couche de confort.
function subscriptionTab(store: FleetStore, org: OrgSummary | null, onChanged: () => void): HTMLElement {
  if (!org) return el("span", {}, []);
  const ent = store.entitlementFor(org.id);

  const subSelect = el("select", { class: "form-select" }, SUBSCRIPTION_TYPES.map((s) => el("option", { value: s.key }, [s.label]))) as HTMLSelectElement;
  subSelect.value = ent?.subscriptionType ?? "demo";

  // Pas de ligne d'entitlement = TOUT est accordé (défaut ouvert, cf. migration 0011). On coche
  // donc tout, pour que l'écran montre l'état RÉEL et non un formulaire vide trompeur.
  const moduleChecks = MODULES.map((m) => {
    const input = el("input", { class: "form-check-input", type: "checkbox" }) as HTMLInputElement;
    input.checked = ent ? ent.enabledModules.includes(m.key) : true;
    const label = el("label", { class: "form-check" }, [
      input,
      el("span", { class: "form-check-label" }, [m.label]),
      m.view ? el("span", { class: "form-check-description" }, [`Masque ou grise le menu « ${m.label} » du back-office.`]) : el("span", {}, []),
    ]);
    return { key: m.key, input, label };
  });

  const status = el("div", { class: "small" }, []);
  const save = el("button", { class: "btn btn-primary", type: "button" }, ["Enregistrer"]);
  save.addEventListener("click", () => {
    status.className = "small text-secondary";
    status.textContent = "Enregistrement…";
    save.setAttribute("disabled", "true");
    void store
      .saveEntitlements(org.id, {
        subscriptionType: subSelect.value,
        enabledModules: moduleChecks.filter((c) => c.input.checked).map((c) => c.key),
      })
      .then((res) => {
        save.removeAttribute("disabled");
        if (res.ok) {
          // `saveEntitlements` recharge et réémet → cet arbre est détaché juste après : le toast
          // (ancré sur body) est le seul retour que l'opérateur verra réellement.
          toast("Souscription & modules enregistrés ✓");
          onChanged();
        } else {
          status.className = "small text-danger";
          status.textContent = res.error ?? "Échec de l'enregistrement.";
        }
      });
  });

  return el("div", { class: "card" }, [
    el("div", { class: "card-body" }, [
      el("div", { class: "alert alert-info" }, [
        "Réglages PLATEFORME : l'organisation les subit et ne peut pas les modifier elle-même. Sans ligne enregistrée, tous les modules sont considérés comme accordés.",
      ]),
      el("div", { class: "mb-3" }, [
        el("label", { class: "form-label" }, ["Souscription"]),
        subSelect,
        el("div", { class: "form-hint" }, ["Le palier est un libellé commercial : ce sont les modules ci-dessous qui décident réellement de ce qui est visible."]),
      ]),
      el("div", { class: "mb-3" }, [el("label", { class: "form-label" }, ["Modules accordés"]), ...moduleChecks.map((c) => c.label)]),
      el("div", { class: "d-flex align-items-center gap-3" }, [save, status]),
    ]),
  ]);
}

// ── Onglet Membres ────────────────────────────────────────────────────────────
function membersTab(store: FleetStore, org: OrgSummary | null, canManage: boolean): HTMLElement {
  if (!org) return el("span", {}, []);
  const wrap = el("div", { class: "card" }, [el("div", { class: "card-body text-secondary" }, ["Chargement des membres…"])]);
  const load = (): void => {
    void store.orgMembers(org.id).then((members) => wrap.replaceChildren(membersTable(store, members, canManage, load)));
  };
  load();
  return wrap;
}

function membersTable(store: FleetStore, members: OrgMember[], canManage: boolean, reload: () => void): HTMLElement {
  const rows = members.map((m) => {
    const roleCell = canManage && !m.isSelf
      ? (() => {
          const sel = el("select", { class: "form-select form-select-sm w-auto" }, ROLE_ORDER.map((r) => el("option", { value: r, ...(r === m.role ? { selected: "selected" } : {}) }, [ROLE_LABELS[r]]))) as HTMLSelectElement;
          sel.addEventListener("change", () => {
            void store.setMemberRole(m.membershipId, sel.value as OrgRole).then((res) => {
              if (!res.ok) {
                alert(res.error ?? "Échec du changement de rôle.");
                sel.value = m.role;
              } else reload();
            });
          });
          return sel;
        })()
      : el("span", { class: "badge bg-secondary-lt" }, [ROLE_LABELS[m.role]]);

    const remove = canManage && !m.isSelf
      ? (() => {
          const b = el("button", { class: "btn btn-sm btn-outline-danger", type: "button" }, ["Retirer"]);
          b.addEventListener("click", () => {
            if (!confirm(`Retirer ${m.email} de l'organisation ?`)) return;
            void store.removeMember(m.membershipId).then((res) => (res.ok ? reload() : alert(res.error ?? "Échec.")));
          });
          return b;
        })()
      : el("span", { class: "text-secondary" }, [m.isSelf ? "vous" : ""]);

    return el("tr", {}, [
      el("td", {}, [el("div", { class: "fw-bold" }, [m.name || m.email]), m.name ? el("div", { class: "text-secondary small" }, [m.email]) : el("span", {}, [])]),
      el("td", {}, [roleCell]),
      el("td", { class: "text-end" }, [remove]),
    ]);
  });

  return el("div", { class: "card" }, [
    el("div", { class: "table-responsive" }, [
      el("table", { class: "table table-vcenter card-table" }, [
        el("thead", {}, [el("tr", {}, [el("th", {}, ["Membre"]), el("th", {}, ["Rôle"]), el("th", {}, [])])]),
        el("tbody", {}, rows.length ? rows : [el("tr", {}, [el("td", { colspan: "3", class: "text-secondary text-center py-4" }, ["Aucun membre."])])]),
      ]),
    ]),
  ]);
}

// ── Onglet Invitations ────────────────────────────────────────────────────────
function invitesTab(store: FleetStore, org: OrgSummary | null, canManage: boolean): HTMLElement {
  if (!org) return el("span", {}, []);
  const wrap = el("div", {}, [el("div", { class: "card" }, [el("div", { class: "card-body text-secondary" }, ["Chargement…"])])]);
  const load = (): void => {
    void store.orgInvitations(org.id).then((invites) => {
      const list = invites.filter((i) => i.status === "pending");
      const rows = list.map((i) => {
        const link = `${location.origin}${location.pathname}?invite=${i.token}`;
        const copy = el("button", { class: "btn btn-sm", type: "button" }, ["Copier le lien"]);
        copy.addEventListener("click", () => void navigator.clipboard?.writeText(link).then(() => { copy.textContent = "Copié ✓"; }));
        const revoke = el("button", { class: "btn btn-sm btn-outline-danger ms-1", type: "button" }, ["Révoquer"]);
        revoke.addEventListener("click", () => void store.revokeInvitation(i.id).then((res) => (res.ok ? load() : alert(res.error ?? "Échec."))));
        return el("tr", {}, [
          el("td", { class: "fw-bold" }, [i.email]),
          el("td", {}, [el("span", { class: "badge bg-secondary-lt" }, [ROLE_LABELS[i.role]])]),
          el("td", { class: "text-secondary small" }, [`expire le ${new Date(i.expiresAt).toLocaleDateString("fr-FR")}`]),
          el("td", { class: "text-end" }, canManage ? [copy, revoke] : []),
        ]);
      });
      const table = el("div", { class: "card" }, [
        el("div", { class: "table-responsive" }, [
          el("table", { class: "table table-vcenter card-table" }, [
            el("thead", {}, [el("tr", {}, [el("th", {}, ["E-mail"]), el("th", {}, ["Rôle"]), el("th", {}, ["Expiration"]), el("th", {}, [])])]),
            el("tbody", {}, rows.length ? rows : [el("tr", {}, [el("td", { colspan: "4", class: "text-secondary text-center py-4" }, ["Aucune invitation en attente."])])]),
          ]),
        ]),
      ]);
      const invite = el("button", { class: "btn btn-primary mb-3", type: "button", ...(canManage ? {} : { disabled: "true" }) }, ["Inviter un membre"]);
      invite.addEventListener("click", () => openInviteModal(store, org.id, load));
      wrap.replaceChildren(canManage ? invite : el("span", {}, []), table);
    });
  };
  load();
  return wrap;
}

function openInviteModal(store: FleetStore, orgId: string, onDone: () => void): void {
  const email = el("input", { class: "form-control", type: "email", placeholder: "personne@exemple.com" }) as HTMLInputElement;
  const role = el("select", { class: "form-select" }, ROLE_ORDER.map((r) => el("option", { value: r }, [ROLE_LABELS[r]]))) as HTMLSelectElement;
  role.value = "viewer";
  const error = el("div", { class: "alert alert-danger d-none" }, []);
  const linkBox = el("div", { class: "d-none" }, []);
  const create = el("button", { class: "btn btn-primary ms-auto", type: "button" }, ["Créer l'invitation"]);

  create.addEventListener("click", () => {
    error.classList.add("d-none");
    if (!/.+@.+\..+/.test(email.value.trim())) {
      error.textContent = "E-mail invalide.";
      error.classList.remove("d-none");
      return;
    }
    create.setAttribute("disabled", "true");
    void store.createInvitation(orgId, email.value, role.value as OrgRole).then((res) => {
      create.removeAttribute("disabled");
      if (!res.ok || !res.link) {
        error.textContent = res.error ?? "Échec.";
        error.classList.remove("d-none");
        return;
      }
      const input = el("input", { class: "form-control", type: "text", value: res.link, readonly: "true" }) as HTMLInputElement;
      const copy = el("button", { class: "btn", type: "button" }, ["Copier"]);
      copy.addEventListener("click", () => void navigator.clipboard?.writeText(res.link!).then(() => { copy.textContent = "Copié ✓"; }));
      linkBox.replaceChildren(
        el("div", { class: "alert alert-success" }, ["Invitation créée. Envoyez ce lien à la personne (il expire dans 14 jours) :"]),
        el("div", { class: "input-group" }, [input, copy]),
      );
      linkBox.classList.remove("d-none");
      create.classList.add("d-none");
      onDone();
    });
  });

  const modalEl = el("div", { class: "modal modal-blur fade", tabindex: "-1" }, [
    el("div", { class: "modal-dialog modal-dialog-centered" }, [
      el("div", { class: "modal-content" }, [
        el("div", { class: "modal-header" }, [el("h3", { class: "modal-title" }, ["Inviter un membre"]), el("button", { class: "btn-close", type: "button", "data-bs-dismiss": "modal" }, [])]),
        el("div", { class: "modal-body" }, [
          error,
          el("div", { class: "mb-3" }, [el("label", { class: "form-label" }, ["E-mail"]), email]),
          el("div", { class: "mb-3" }, [el("label", { class: "form-label" }, ["Rôle"]), role]),
          linkBox,
        ]),
        el("div", { class: "modal-footer" }, [el("button", { class: "btn", type: "button", "data-bs-dismiss": "modal" }, ["Fermer"]), create]),
      ]),
    ]),
  ]);
  document.body.append(modalEl);
  const modal = new Modal(modalEl);
  modalEl.addEventListener("hidden.bs.modal", () => modalEl.remove(), { once: true });
  modal.show();
}

// ── Onglet Rôles & permissions (matrice statique) ─────────────────────────────
function rolesTab(): HTMLElement {
  const head = el("tr", {}, [el("th", {}, ["Permission"]), ...ROLE_ORDER.map((r) => el("th", { class: "text-center" }, [ROLE_LABELS[r]]))]);
  const rows = PERMISSION_MATRIX.map((p) =>
    el("tr", {}, [
      el("td", {}, [p.label]),
      ...ROLE_ORDER.map((r) => el("td", { class: "text-center" }, [p.roles[r] ? el("span", { class: "text-green" }, ["✓"]) : el("span", { class: "text-secondary" }, ["—"])])),
    ]),
  );
  const legend = el("div", { class: "card-body text-secondary small" }, ROLE_ORDER.map((r) => el("div", {}, [el("strong", {}, [ROLE_LABELS[r] + " : "]), ROLE_HINTS[r]])));
  return el("div", { class: "card" }, [
    el("div", { class: "table-responsive" }, [el("table", { class: "table table-vcenter card-table" }, [el("thead", {}, [head]), el("tbody", {}, rows)])]),
    legend,
  ]);
}

// ── Onglet Kiosks associées (lecture) ────────────────────────────────────────
function boothsTab(store: FleetStore, org: OrgSummary | null): HTMLElement {
  if (!org) return el("span", {}, []);
  const booths = store.visibleBooths().filter((b) => b.organizationId === org.id);
  const rows = booths.map((b) =>
    el("tr", {}, [
      el("td", {}, [el("div", { class: "fw-bold" }, [b.label]), el("div", { class: "text-secondary small" }, [b.location || b.address || "—"])]),
      el("td", { class: "text-secondary" }, [b.health]),
      el("td", { class: "text-secondary" }, [b.softwareVersion || "—"]),
    ]),
  );
  return el("div", { class: "card" }, [
    el("div", { class: "table-responsive" }, [
      el("table", { class: "table table-vcenter card-table" }, [
        el("thead", {}, [el("tr", {}, [el("th", {}, ["Kiosk"]), el("th", {}, ["Santé"]), el("th", {}, ["Version"])])]),
        el("tbody", {}, rows.length ? rows : [el("tr", {}, [el("td", { colspan: "3", class: "text-secondary text-center py-4" }, ["Aucun Kiosk associé."])])]),
      ]),
    ]),
  ]);
}

// ── Onglet Paiement (intégrations, config non-secrète) ────────────────────────
function billingTab(store: FleetStore, org: OrgSummary | null, canManage: boolean): HTMLElement {
  if (!org) return el("span", {}, []);
  const wrap = el("div", {}, [el("div", { class: "card" }, [el("div", { class: "card-body text-secondary" }, ["Chargement…"])])]);
  const load = (): void => {
    void store.orgPaymentIntegrations(org.id).then((integrations) => {
      const rows = integrations.map((pi) => {
        const del = el("button", { class: "btn btn-sm btn-outline-danger", type: "button" }, ["Suppr."]);
        del.addEventListener("click", () => {
          if (!confirm("Supprimer cette intégration ?")) return;
          void store.deletePaymentIntegration(pi.id).then((res) => (res.ok ? load() : alert(res.error ?? "Échec.")));
        });
        return el("tr", {}, [
          el("td", { class: "fw-bold" }, [pi.label || pi.provider]),
          el("td", {}, [pi.provider]),
          el("td", {}, [el("span", { class: `badge ${pi.mode === "live" ? "bg-red-lt" : "bg-secondary-lt"}` }, [pi.mode])]),
          el("td", {}, [el("span", { class: `badge ${pi.status === "active" ? "bg-green-lt" : "bg-secondary-lt"}` }, [pi.status])]),
          el("td", { class: "text-end" }, canManage ? [del] : []),
        ]);
      });
      const add = el("button", { class: "btn btn-primary mb-3", type: "button", ...(canManage ? {} : { disabled: "true" }) }, ["Ajouter une intégration"]);
      add.addEventListener("click", () => openIntegrationModal(store, org.id, load));
      wrap.replaceChildren(
        el("div", { class: "alert alert-info" }, [`Devise de l'organisation : ${org.currency}. Le sans-contact passe par le provider « card » (Stripe Terminal), branché en phase rue. Les secrets (clés API) sont stockés côté serveur — jamais ici.`]),
        canManage ? add : el("span", {}, []),
        el("div", { class: "card" }, [
          el("div", { class: "table-responsive" }, [
            el("table", { class: "table table-vcenter card-table" }, [
              el("thead", {}, [el("tr", {}, [el("th", {}, ["Libellé"]), el("th", {}, ["Provider"]), el("th", {}, ["Mode"]), el("th", {}, ["Statut"]), el("th", {}, [])])]),
              el("tbody", {}, rows.length ? rows : [el("tr", {}, [el("td", { colspan: "5", class: "text-secondary text-center py-4" }, ["Aucune intégration configurée."])])]),
            ]),
          ]),
        ]),
      );
    });
  };
  load();
  return wrap;
}

function openIntegrationModal(store: FleetStore, orgId: string, onDone: () => void): void {
  const label = el("input", { class: "form-control", type: "text", placeholder: "ex. Compte Stripe FR" }) as HTMLInputElement;
  const provider = el("select", { class: "form-select" }, ["mock", "free", "coin", "stripe_terminal", "sumup"].map((p) => el("option", { value: p }, [p]))) as HTMLSelectElement;
  const mode = el("select", { class: "form-select" }, ["test", "live"].map((m) => el("option", { value: m }, [m]))) as HTMLSelectElement;
  const status = el("select", { class: "form-select" }, ["inactive", "active", "error"].map((s) => el("option", { value: s }, [s]))) as HTMLSelectElement;
  const error = el("div", { class: "alert alert-danger d-none" }, []);
  const save = el("button", { class: "btn btn-primary ms-auto", type: "button" }, ["Enregistrer"]);
  save.addEventListener("click", () => {
    error.classList.add("d-none");
    save.setAttribute("disabled", "true");
    void store.savePaymentIntegration(orgId, { provider: provider.value, mode: mode.value, status: status.value, label: label.value.trim() }).then((res) => {
      save.removeAttribute("disabled");
      if (res.ok) {
        modal.hide();
        onDone();
      } else {
        error.textContent = res.error ?? "Échec.";
        error.classList.remove("d-none");
      }
    });
  });
  const field = (l: string, input: HTMLElement): HTMLElement => el("div", { class: "mb-3" }, [el("label", { class: "form-label" }, [l]), input]);
  const modalEl = el("div", { class: "modal modal-blur fade", tabindex: "-1" }, [
    el("div", { class: "modal-dialog modal-dialog-centered" }, [
      el("div", { class: "modal-content" }, [
        el("div", { class: "modal-header" }, [el("h3", { class: "modal-title" }, ["Intégration de paiement"]), el("button", { class: "btn-close", type: "button", "data-bs-dismiss": "modal" }, [])]),
        el("div", { class: "modal-body" }, [error, field("Libellé", label), field("Provider", provider), field("Mode", mode), field("Statut", status), el("div", { class: "form-hint" }, ["Config non-secrète uniquement. Les clés API se configurent côté serveur (Vault)."])]),
        el("div", { class: "modal-footer" }, [el("button", { class: "btn", type: "button", "data-bs-dismiss": "modal" }, ["Annuler"]), save]),
      ]),
    ]),
  ]);
  document.body.append(modalEl);
  const modal = new Modal(modalEl);
  modalEl.addEventListener("hidden.bs.modal", () => modalEl.remove(), { once: true });
  modal.show();
}

// ── Onglet Accès opérateur (CIN-073, F17 volet A) ─────────────────────────────
// Gère les identifiants+PIN d'accès au menu opérateur des Kiosks. Le PIN est haché à
// la création (domaine) et n'est JAMAIS relu ni affiché ici. Révocation/expiration =
// effectives à la prochaine sync de la Kiosk (eventually consistent, hors ligne compris).
const ACTION_LABELS: Record<string, string> = {
  login_ok: "Connexion",
  login_fail: "Échec de connexion",
  wifi_connect: "Wi-Fi",
  restart: "Redémarrage",
};

export function accessStatus(a: OperatorAccessRecord): { label: string; cls: string } {
  if (a.revoked) return { label: "Révoqué", cls: "bg-danger-lt" };
  if (a.expiresAt && Date.parse(a.expiresAt) <= Date.now()) return { label: "Expiré", cls: "bg-orange-lt" };
  return { label: "Actif", cls: "bg-green-lt" };
}

function accessTab(store: FleetStore, org: OrgSummary | null, canManage: boolean): HTMLElement {
  if (!org) return el("span", {}, []);
  const booths = store.visibleBooths().filter((b) => b.organizationId === org.id);
  const boothLabel = (id: string | null): string =>
    id === null ? "Toutes les Kiosks" : (booths.find((b) => b.id === id)?.label ?? "Kiosk inconnue");

  const wrap = el("div", {}, [el("div", { class: "card" }, [el("div", { class: "card-body text-secondary" }, ["Chargement des accès…"])])]);

  const load = (): void => {
    void Promise.all([store.listOperatorAccess(org.id), store.listOperatorAccessLog(org.id)]).then(([accesses, log]) => {
      // — Table des accès —
      const rows = accesses.map((a) => {
        const st = accessStatus(a);
        const actions: HTMLElement[] = [];
        if (canManage) {
          const toggle = el("button", { class: `btn btn-sm ${a.revoked ? "btn-outline-success" : "btn-outline-danger"}`, type: "button" }, [a.revoked ? "Réactiver" : "Révoquer"]);
          toggle.addEventListener("click", () => void store.setOperatorAccessRevoked(a.id, !a.revoked).then((r) => (r.ok ? load() : alert(r.error ?? "Échec."))));
          const del = el("button", { class: "btn btn-sm btn-outline-danger ms-1", type: "button" }, ["Supprimer"]);
          del.addEventListener("click", () => {
            if (!confirm(`Supprimer définitivement l'accès « ${a.identifier} » ?`)) return;
            void store.deleteOperatorAccess(a.id).then((r) => (r.ok ? load() : alert(r.error ?? "Échec.")));
          });
          actions.push(toggle, del);
        }
        return el("tr", {}, [
          el("td", {}, [el("div", { class: "fw-bold" }, [a.identifier]), a.label ? el("div", { class: "text-secondary small" }, [a.label]) : el("span", {}, [])]),
          el("td", {}, [el("span", { class: "badge bg-secondary-lt" }, [OPERATOR_ROLE_LABELS[a.role]])]),
          el("td", { class: "text-secondary small" }, [boothLabel(a.boothId)]),
          el("td", { class: "text-secondary small" }, [a.expiresAt ? new Date(a.expiresAt).toLocaleDateString("fr-FR") : "—"]),
          el("td", {}, [el("span", { class: `badge ${st.cls}` }, [st.label])]),
          el("td", { class: "text-end" }, actions),
        ]);
      });

      const addBtn = el("button", { class: "btn btn-primary mb-3", type: "button", ...(canManage ? {} : { disabled: "true" }) }, ["Créer un accès"]);
      addBtn.addEventListener("click", () => openAccessModal(store, org, booths, accesses.map((a) => a.identifier), load));

      const accessCard = el("div", { class: "card" }, [
        el("div", { class: "table-responsive" }, [
          el("table", { class: "table table-vcenter card-table" }, [
            el("thead", {}, [el("tr", {}, [el("th", {}, ["Identifiant"]), el("th", {}, ["Rôle"]), el("th", {}, ["Portée"]), el("th", {}, ["Expiration"]), el("th", {}, ["Statut"]), el("th", {}, [])])]),
            el("tbody", {}, rows.length ? rows : [el("tr", {}, [el("td", { colspan: "6", class: "text-secondary text-center py-4" }, ["Aucun accès opérateur. Créez-en un pour ouvrir le menu Wi-Fi/réglages d'une Kiosk."])])]),
          ]),
        ]),
      ]);

      // — Journal d'accès —
      const logRows = log.map((l) =>
        el("tr", {}, [
          el("td", { class: "text-secondary small" }, [new Date(l.at).toLocaleString("fr-FR")]),
          el("td", {}, [l.identifier ?? el("span", { class: "text-secondary" }, ["—"])]),
          el("td", {}, [ACTION_LABELS[l.action] ?? l.action]),
          el("td", { class: "text-secondary small" }, [l.boothId ? boothLabel(l.boothId) : "—"]),
          el("td", { class: "text-secondary small" }, [l.detail ?? ""]),
        ]),
      );
      const logCard = el("div", { class: "card mt-4" }, [
        el("div", { class: "card-header" }, [el("h3", { class: "card-title m-0" }, ["Journal d'accès"]), el("div", { class: "card-subtitle" }, ["Remonté par les Kiosks (100 dernières entrées)."])]),
        el("div", { class: "table-responsive" }, [
          el("table", { class: "table table-vcenter card-table" }, [
            el("thead", {}, [el("tr", {}, [el("th", {}, ["Quand"]), el("th", {}, ["Identifiant"]), el("th", {}, ["Action"]), el("th", {}, ["Kiosk"]), el("th", {}, ["Détail"])])]),
            el("tbody", {}, logRows.length ? logRows : [el("tr", {}, [el("td", { colspan: "5", class: "text-secondary text-center py-4" }, ["Aucune entrée de journal."])])]),
          ]),
        ]),
      ]);

      wrap.replaceChildren(canManage ? addBtn : el("span", {}, []), accessCard, logCard);
    });
  };
  load();
  return wrap;
}

export function openAccessModal(
  store: FleetStore,
  org: OrgSummary,
  booths: ReadonlyArray<{ id: string; label: string }>,
  existingIds: readonly string[],
  onDone: () => void,
  defaultBoothId?: string | null,
): void {
  const orgSlug = slugify(org.name);
  let generatedPin = randomPin();

  // Identifiant (CIN-076) : préfixe figé (org / kiosk selon la portée), suffixe éditable OPTIONNEL.
  const prefixAddon = el("span", { class: "input-group-text" }, [""]);
  const suffix = el("input", { class: "form-control", type: "text", autocomplete: "off", placeholder: "" }) as HTMLInputElement;
  const preview = el("div", { class: "form-hint" }, [""]);

  const pinDisplay = el("input", { class: "form-control form-control-lg text-center fw-bold", type: "text", readonly: "true", value: generatedPin, style: "letter-spacing:.3em;font-variant-numeric:tabular-nums" }) as HTMLInputElement;
  const regen = el("button", { class: "btn", type: "button" }, ["Régénérer"]);
  regen.addEventListener("click", () => {
    generatedPin = randomPin();
    pinDisplay.value = generatedPin;
  });
  const role = el("select", { class: "form-select" }, (["operator", "super_user"] as const).map((r) => el("option", { value: r }, [OPERATOR_ROLE_LABELS[r]]))) as HTMLSelectElement;
  const scope = el("select", { class: "form-select" }, [el("option", { value: "" }, ["Toutes les Kiosks de l'organisation"]), ...booths.map((b) => el("option", { value: b.id }, [b.label]))]) as HTMLSelectElement;
  // Depuis le hub cabine (CIN-045) : portée pré-sélectionnée sur cette cabine.
  if (defaultBoothId && booths.some((b) => b.id === defaultBoothId)) scope.value = defaultBoothId;
  const label = el("input", { class: "form-control", type: "text", placeholder: "Note (ex. bénévole festival)", autocomplete: "off" }) as HTMLInputElement;
  const expiry = el("input", { class: "form-control", type: "date" }) as HTMLInputElement;
  const error = el("div", { class: "alert alert-danger d-none" }, []);
  const successBox = el("div", { class: "d-none" }, []);
  const create = el("button", { class: "btn btn-primary ms-auto", type: "button" }, ["Créer l'accès"]);

  const boothSlug = (id: string): string => {
    const b = booths.find((x) => x.id === id);
    return b ? slugify(b.label, 10) : "";
  };
  const currentPrefix = (): string => {
    const bs = scope.value ? boothSlug(scope.value) : "";
    return bs ? `${orgSlug}-${bs}-` : `${orgSlug}-`;
  };
  // Suffixe auto (portée + rôle) : garantit l'unicité `unique(org, identifier)` en incrémentant.
  const autoSuffix = (prefix: string): string => {
    const base = ROLE_SUFFIX[role.value as OperatorRole];
    let cand = base;
    let n = 1;
    while (existingIds.includes(prefix + cand)) {
      n += 1;
      cand = `${base}${n}`;
    }
    return cand;
  };
  const finalId = (): string => {
    const prefix = currentPrefix();
    const s = slugify(suffix.value, 16);
    return prefix + (s || autoSuffix(prefix));
  };
  const refresh = (): void => {
    const prefix = currentPrefix();
    prefixAddon.textContent = prefix;
    suffix.placeholder = autoSuffix(prefix);
    preview.textContent = `Identifiant complet : ${finalId()}`;
  };
  scope.addEventListener("change", refresh);
  role.addEventListener("change", refresh);
  suffix.addEventListener("input", refresh);

  create.addEventListener("click", () => {
    error.classList.add("d-none");
    const id = finalId();
    create.setAttribute("disabled", "true");
    // On capture le PIN affiché AU MOMENT de la création (l'utilisateur a pu régénérer).
    const pinAtCreate = generatedPin;
    void store
      .createOperatorAccess(org.id, {
        identifier: id,
        pin: pinAtCreate,
        role: role.value as OperatorRole,
        boothId: scope.value || null,
        expiresAt: expiry.value ? new Date(`${expiry.value}T23:59:59`).toISOString() : null,
        label: label.value.trim(),
      })
      .then((res) => {
        create.removeAttribute("disabled");
        if (!res.ok) {
          const dup = /duplicate|unique/i.test(res.error ?? "");
          return fail(dup ? "Cet identifiant existe déjà — personnalisez le suffixe." : (res.error ?? "Échec de la création."));
        }
        // PIN affiché une SEULE fois : non stocké en clair, non récupérable ensuite.
        successBox.replaceChildren(
          el("div", { class: "alert alert-success" }, [
            el("div", { class: "fw-bold mb-1" }, [`Accès « ${id} » créé.`]),
            el("div", {}, ["Communiquez ce PIN à l'opérateur maintenant — il ne sera pas récupérable :"]),
            el("div", { class: "h1 text-center my-2", style: "letter-spacing:.3em;font-variant-numeric:tabular-nums" }, [pinAtCreate]),
          ]),
        );
        successBox.classList.remove("d-none");
        form.classList.add("d-none");
        create.classList.add("d-none");
        onDone();
      });
  });

  function fail(msg: string): void {
    error.textContent = msg;
    error.classList.remove("d-none");
  }
  const field = (l: string, hint: string, input: HTMLElement): HTMLElement =>
    el("div", { class: "mb-3" }, [el("label", { class: "form-label" }, [l]), input, hint ? el("div", { class: "form-hint" }, [hint]) : el("span", {}, [])]);

  const form = el("div", {}, [
    el("div", { class: "mb-3" }, [
      el("label", { class: "form-label" }, ["Identifiant"]),
      el("div", { class: "input-group" }, [prefixAddon, suffix]),
      preview,
      el("div", { class: "form-hint" }, ["Préfixe fixe (organisation / kiosk selon la portée). Le suffixe est optionnel : laissé vide, il est renseigné automatiquement d'après le rôle."]),
    ]),
    el("div", { class: "mb-3" }, [
      el("label", { class: "form-label" }, ["PIN (généré automatiquement)"]),
      el("div", { class: "input-group" }, [pinDisplay, regen]),
      el("div", { class: "form-hint" }, ["Généré aléatoirement, affiché une seule fois à la création. Non modifiable, non récupérable ensuite."]),
    ]),
    field("Rôle", "", role),
    field("Portée", "Restreindre à une Kiosk, ou valable sur toute l'organisation.", scope),
    field("Expiration (optionnelle)", "Au-delà, l'accès est refusé (utile pour un événement).", expiry),
    field("Note (optionnelle)", "", label),
  ]);

  const modalEl = el("div", { class: "modal modal-blur fade", tabindex: "-1" }, [
    el("div", { class: "modal-dialog modal-dialog-centered" }, [
      el("div", { class: "modal-content" }, [
        el("div", { class: "modal-header" }, [el("h3", { class: "modal-title" }, ["Nouvel accès opérateur"]), el("button", { class: "btn-close", type: "button", "data-bs-dismiss": "modal" }, [])]),
        el("div", { class: "modal-body" }, [error, successBox, form]),
        el("div", { class: "modal-footer" }, [el("button", { class: "btn", type: "button", "data-bs-dismiss": "modal" }, ["Fermer"]), create]),
      ]),
    ]),
  ]);
  document.body.append(modalEl);
  const modal = new Modal(modalEl);
  modalEl.addEventListener("hidden.bs.modal", () => modalEl.remove(), { once: true });
  refresh();
  modal.show();
}

const tabRenderers: Record<Tab, (store: FleetStore, org: OrgSummary | null, canManage: boolean, onChanged: () => void) => HTMLElement> = {
  general: generalTab,
  subscription: (store, org, _canManage, onChanged) => subscriptionTab(store, org, onChanged),
  members: membersTab,
  invites: invitesTab,
  roles: () => rolesTab(),
  booths: (store, org) => boothsTab(store, org),
  styles: (store, org, canManage) => orgStyleSettingsTab(store, org, canManage),
  access: (store, org, canManage) => accessTab(store, org, canManage),
  billing: billingTab,
};
