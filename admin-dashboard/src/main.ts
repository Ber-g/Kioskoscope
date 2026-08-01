// Feuilles de style : Tabler (design system), Gridstack (widgets), nos ajustements.
import "@tabler/core/dist/css/tabler.min.css";
import "gridstack/dist/gridstack.min.css";
// Règles de largeur pour les grilles ≠ 12 colonnes (`.gs-1`…`.gs-11`). Sans ce
// fichier, une grille en 6/3/2 colonnes n'a AUCUNE règle de largeur → tuiles à
// `width: 0` (invisibles). `gridstack.min.css` seul ne couvre que le 12 colonnes.
import "gridstack/dist/gridstack-extra.min.css";
import "./styles.css";

// Import de Bootstrap pour activer les data-API (dropdown de rôle, collapse de la
// barre latérale). Les composants pilotés à la main (Offcanvas, Modal) restent
// importés là où on les instancie.
import "bootstrap";

import { FleetStore } from "./data/store";
import { App } from "./ui/app";
import { sweepStaleUploads } from "./data/upload";

const root = document.getElementById("app");
if (!root) throw new Error("Élément #app introuvable");

const store = new FleetStore();
const app = new App(root, store);
app.start(); // rend + lance le chargement async (mock ou Supabase)

// Un envoi abandonné laisse des octets que le bucket NE MONTRE PAS : `storage.list()` ne les
// voit pas, donc aucun écran ne peut les inventorier. Seule l'URL d'envoi, gardée localement,
// permet de les révoquer. Ce balayage est donc le seul ramasse-miettes qui existe côté produit
// — et il ne peut agir que sur ce navigateur-ci. Cf. CIN-101 et la note du QA-LOG.
void sweepStaleUploads();
