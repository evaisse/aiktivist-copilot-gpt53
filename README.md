# aiktivist

## 1) Objectif produit

Construire une application web pour piloter des agents IA et converser avec eux, avec :

- Bun comme runtime et outil principal.
- Fly.io comme cible de déploiement (déploiement déclenché par push sur `main`).
- Filesystem + SQLite (via Bun) pour la persistance.
- Authentification par login/mot de passe.
- Interface orientée terminal, minimaliste, réactive, et pilotée par événements.

## 2) Mode d'exécution obligatoire de l'agent implémenteur

Cette section est contractuelle.

- L'agent doit exécuter la demande de bout en bout sans s'arrêter au milieu.
- L'agent peut poser des questions uniquement au démarrage, en une passe courte, et seulement si un blocage critique empêche d'avancer.
- Après ce démarrage, l'agent ne doit plus interrompre pour poser des questions : il choisit des hypothèses raisonnables, les applique, et termine le travail.
- L'agent doit livrer un résultat fonctionnel complet, pas une implémentation partielle.
- L'agent doit exécuter les tests, corriger les erreurs, puis fournir un récapitulatif final avec les hypothèses prises.
- L'agent ne doit pas renvoyer de TODO non traités pour les éléments demandés.

## 3) Contraintes techniques non négociables

### Runtime, tooling, DX

- Utiliser Bun uniquement pour la DX et les commandes de dev/build/test.
- Fournir un `Makefile` pour les commandes courantes.
- Ne pas introduire de dépendance à Node/npm/pnpm/yarn pour la chaîne principale.

### IA

- Utiliser exclusivement OpenRouter comme gateway IA.
- Les appels OpenRouter doivent être effectués par le serveur (jamais directement par le client).
- Modèle par défaut obligatoire : `google/gemini-3-flash-preview`.
- Endpoint OpenRouter fourni via variable d'environnement.
- Clé OpenRouter fournie via variable d'environnement.

### Déploiement

- Le déploiement Fly.io est géré par hook sur push `main`.
- Ne pas utiliser la CLI Fly.io.
- Ne pas utiliser GitHub Actions pour le déploiement.
- Ne pas inclure de plan de déploiement ni de manipulation de clés Fly.io.

### Persistance et sécurité

- Utiliser SQLite (Bun SQLite) avec un système de migrations.
- Auth login/mot de passe avec stockage sécurisé du mot de passe (hash, jamais en clair).

## 4) Fonctionnalités à livrer

- Authentification complète : login, logout, protection des routes.
- Routing réel : chaque conversation doit avoir une URL dédiée.
- Historique des conversations avec actions : reprendre, archiver, supprimer.
- Envoi de messages utilisateur et génération de réponses IA en streaming performant.
- Journalisation détaillée et exploitable de tous les échanges et événements.
- Gestion des outils (si présents) avec logs détaillés également.

## 5) Architecture attendue (niveau minimal)

- Backend event-driven.
- Le backend écrit les événements en JSON Lines (`.jsonl`) de façon append-only.
- Le frontend se met à jour en temps réel à partir des événements poussés par le moteur.
- La traçabilité doit couvrir les échanges racine client <-> gateway IA (requêtes, réponses, chunks, erreurs, métadonnées utiles).

Tables minimales recommandées (noms adaptables) :

- `users`
- `sessions`
- `conversations`
- `messages`
- `events`

## 6) UI/UX attendue

- Sensation de rapidité prioritaire.
- Interface hyper minimal graphique, limite text-only, mais interactive.
- Flux conversationnel clair, avec état visible en continu (thinking, streaming, done, erreur).

## 7) Consigne design (style des captures)

### Direction visuelle

- Interface immersive type terminal moderne.
- Très peu de chrome UI : le texte est l'élément principal.
- Sensation "ops/agent runtime" en continu (logs, streaming, état visible).

### Palette (tokens conseillés)

- `--bg-main: #151816` (fond principal très sombre, vert/noir désaturé)
- `--bg-panel: #1b1f1d` (zones secondaires/split)
- `--fg-main: #f1f3ee` (texte principal)
- `--fg-muted: #8a9188` (texte secondaire, méta, "thinking")
- `--accent-user: #8ccf2f` (input utilisateur/prompts)
- `--accent-keyword: #f0d44a` (mots-clés techniques)
- `--accent-link: #4aa3ff` (liens, actions, éléments interactifs)
- `--border-subtle: #2c3230` (séparateurs 1px)

### Typographie

- Police mono en priorité (ex : JetBrains Mono, IBM Plex Mono).
- Corps compact (14-16px), line-height lisible (1.4-1.55).
- Utiliser l'italique uniquement pour les états méta (ex : "Thinking"), jamais pour les réponses principales.

### Hiérarchie visuelle

- Prompt utilisateur : vert accent (`--accent-user`), très identifiable.
- Réponse assistant : texte clair (`--fg-main`) avec emphase ponctuelle sur mots-clés.
- Métadonnées/logs système : gris atténué (`--fg-muted`).
- Séparateurs fins et discrets, pas de cartes lourdes ni ombres marquées.

### Mouvement et layout

- Streaming progressif des réponses caractère par caractère ou ligne par ligne.
- Curseur/caret discret possible.
- Animations minimales, fonctionnelles, jamais décoratives.
- Grille simple, gauche dominante, grands espaces respirants.
- Split pane possible (zone principale + queue/logs).
- Responsive desktop/mobile sans casser la lisibilité.

### Do / Don't

Do :

- Prioriser lisibilité, latence perçue, retour d'état en temps réel.
- Garder une esthétique sobre, technique, "CLI augmentée".

Don't :

- Pas de composants "dashboard glossy", pas de grosses cards.
- Pas d'effets visuels gratuits (blur fort, gradients flashy, micro-animations partout).
- Pas de surcharge de couleurs : 1 couleur dominante + 2 accents max.

## 8) Qualité, tests, validation

- Ajouter des tests (`bun test`) : unitaires et/ou e2e.
- Les tests doivent couvrir au minimum :
  - auth et protection de routes,
  - routing conversationnel,
  - persistance conversation/messages,
  - streaming de réponse,
  - journalisation d'événements.
- Fournir un système de migrations opérationnel et reproductible.

## 9) Définition de terminé (Definition of Done)

Le travail est terminé uniquement si :

- l'application est fonctionnelle de bout en bout,
- les contraintes non négociables sont respectées,
- les migrations fonctionnent sur une base propre,
- les tests passent,
- le résultat est cohérent avec la consigne visuelle,
- un résumé final liste les choix techniques et hypothèses appliquées.
