# Jagruk Mahila RAG service

This is an optional, standalone retrieval-augmented generation (RAG) chat backend for the existing Expo app. It indexes the English, Hindi and Urdu content in `data/`, creates multilingual semantic embeddings locally with Transformers.js, retrieves relevant passages by cosine similarity, then asks Groq's chat API to answer using that context. It needs no vector database or embedding API key. If the embedding model cannot load, it falls back to lexical retrieval; if retrieval finds no passages, it still asks Groq for a cautious general answer and labels it as ungrounded by the app sources.

The current Express backend and app already exchange `POST /chat` requests shaped as `{ "question": "..." }` and expect `{ "answer": "..." }`. This service uses that same contract; it can be deployed on its own or used as the app's chat backend.

## Run locally

Requirements: Node.js 20 or newer, internet access on first start to download the embedding model, and a Groq API key. Create a key in the Groq console. If a real key was pasted into chat, revoke it and create a replacement before use.

```sh
cd rag
npm install
cp .env.example .env
```

Put the replacement key in `rag/.env` as `GROQ_API_KEY=...`. Never use an `EXPO_PUBLIC_` variable for a provider key. Then:

```sh
npm start
```

Check `http://localhost:3001/health`; send a request to `POST http://localhost:3001/chat` with JSON `{"question":"What can I do if I am in immediate danger?"}`.

## Deploy to Render

The RAG service is self-contained: its knowledge base is bundled in `data/`. When deploying the contents of the `rag/` folder as its own repository, use the repository root as the service root. If deploying from the main app monorepo, leave Render's **Root Directory empty** and scope the commands to `rag/`.

1. Push the project to a GitHub repository Render can access.
2. In the Render Dashboard, choose **New → Web Service**, connect the repository, and select the branch to deploy.
3. Configure the service:

   | Setting | Value |
   | --- | --- |
   | Name | `jagruk-mahila-rag` (or another available name) |
   | Runtime | `Node` |
   | Root Directory | Repository root (leave blank) |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Health Check Path | `/health` (Advanced settings, optional) |

4. Add environment variables in the service's **Environment** page:

   | Key | Value |
   | --- | --- |
   | `GROQ_API_KEY` | A newly created Groq API key; keep this secret |
| `GROQ_MODEL` | Optional; defaults to `llama-3.3-70b-versatile` |
| `EMBEDDING_MODEL` | Optional; defaults to `Xenova/paraphrase-multilingual-MiniLM-L12-v2` |
   | `ALLOWED_ORIGINS` | Optional; defaults to `*` |

   Render supplies `PORT`; do not hardcode it. Never add the Groq key to Expo variables or commit it in a `.env` file.

5. Choose a plan and click **Create Web Service**. Watch the **Events/Logs** page until the deploy succeeds. Startup logs should report the number of indexed passages.
6. Open `https://YOUR-SERVICE.onrender.com/health`. A healthy service returns JSON like `{"status":"ok","indexedDocuments":123,"embeddingStatus":"ready","embeddedDocuments":123}`. The index count should be greater than zero. Wait for `embeddingStatus` to become `ready`; the first start downloads the multilingual model and builds vectors, which can take a few minutes.
7. Test the endpoint with curl:

   ```sh
   curl -X POST https://YOUR-SERVICE.onrender.com/chat \
     -H 'Content-Type: application/json' \
     -d '{"question":"What can I do if I am in immediate danger?"}'
   ```

   It should return JSON containing an `answer`. If the index count is zero, check that the deployed repository includes the `data/` directory and its JavaScript files.

Render can redeploy on pushes to the selected branch. To update the knowledge base, update the matching files in `data/` and redeploy.

## Connect the existing app

The app uses `EXPO_PUBLIC_CHAT_API_BASE_URL` for chat and `EXPO_PUBLIC_API_BASE_URL` for reports. The former can point directly to this service; keep the latter set to the existing backend so report submissions continue working:

```sh
EXPO_PUBLIC_CHAT_API_BASE_URL=https://YOUR-RAG-SERVICE \
EXPO_PUBLIC_API_BASE_URL=https://jagruk-mahila.onrender.com \
npx expo start
```

For an EAS build, set `EXPO_PUBLIC_CHAT_API_BASE_URL` in the build environment (and retain the report backend URL). Expo public variables contain URLs only; the Groq key belongs only in the server's secret environment. You can also route `/chat` through the existing Express backend by setting its `CHAT_URL` to `https://YOUR-RAG-SERVICE/chat`.

## Full guide: connect the already-deployed Express backend to RAG

Use this setup when the mobile app should keep using its existing backend URL for both chat and reports, and that backend should forward chat to the new Render RAG service. The flow is:

```text
Expo app → existing Express backend /chat → RAG service /chat → Groq
Expo app → existing Express backend /report → current report endpoint
```

### 1. Deploy the RAG service first

Follow the Render steps above and make sure `https://YOUR-RAG-SERVICE.onrender.com/health` succeeds. Copy its base URL, with no trailing slash; for example `https://jagruk-mahila-rag.onrender.com`.

### 2. Update the existing backend's Render environment

In Render, open the already-deployed **Express backend** service (the one running the `backend/` directory), then open **Environment**. Set or update these values:

| Variable | Value | Required? |
| --- | --- | --- |
| `CHAT_URL` | `https://YOUR-RAG-SERVICE.onrender.com/chat` | Yes. Include `/chat`. |
| `CHAT_API_KEY` | Leave unset/blank | No. The RAG service uses its own `GROQ_API_KEY`; the existing backend does not need the Groq key. |
| `REPORT_URL` | Your current report receiver URL | Yes, if users should continue submitting reports. Keep the existing working value. |
| `ALLOWED_ORIGINS` | `*` or your app's web origin(s), comma-separated | Optional for this mobile app; backend default is `*`. |
| `NODE_ENV` | `production` | Optional; set for production error handling. |
| `PORT` | Do not set manually | Render provides this automatically. |

Do not put `GROQ_API_KEY` on the existing backend unless you separately change its code to call Groq directly. The key belongs in the RAG Render service's environment only. Save the environment changes and let Render redeploy the Express service.

### 3. Keep the Expo app pointed at the existing backend

When using this forwarding setup, the app's base URL should remain the existing Express backend URL. The app calls `/chat` and `/report` on that backend; it does not call the RAG service directly.

For local Expo runs:

```sh
EXPO_PUBLIC_API_BASE_URL=https://YOUR-EXPRESS-BACKEND.onrender.com \
npx expo start
```

`EXPO_PUBLIC_CHAT_API_BASE_URL` is optional. Leave it unset so chat uses `EXPO_PUBLIC_API_BASE_URL`, or set it to the same existing Express backend URL. Do not set it to the RAG service URL in this forwarding setup.

For EAS builds, set `EXPO_PUBLIC_API_BASE_URL` to the existing Express backend URL in the build environment (or in the build profile), and ensure `EXPO_PUBLIC_CHAT_API_BASE_URL` is absent or matches that same URL. These Expo variables are public URLs, not secrets. Rebuild the app after changing build-time configuration.

### 4. Verify the whole path

1. Open `https://YOUR-EXPRESS-BACKEND.onrender.com/health`; expect `{"status":"ok"}`.
2. Send a question through the existing backend:

   ```sh
   curl -X POST https://YOUR-EXPRESS-BACKEND.onrender.com/chat \
     -H 'Content-Type: application/json' \
     -H 'x-client-id: render-check' \
     -d '{"question":"What can I do if I am in immediate danger?"}'
   ```

   Expect HTTP 200 and JSON with an `answer`. The existing backend forwards the JSON response from RAG.
3. If chat returns an error, inspect **Logs** for both Render services. Confirm the Express `CHAT_URL` ends with `/chat`, the RAG health check reports a nonzero `indexedDocuments`, and the RAG service has a valid `GROQ_API_KEY`.
4. Test a report from the app or submit a valid `/report` request to confirm `REPORT_URL` was preserved. Chat forwarding does not replace the report route.

### Environment variable summary

| Service | Variable | Set to |
| --- | --- | --- |
| RAG Render service | `GROQ_API_KEY` | Secret Groq key (new/revoked-and-replaced if previously exposed) |
| RAG Render service | `GROQ_MODEL` | Optional; defaults to `llama-3.3-70b-versatile` |
| RAG Render service | `EMBEDDING_MODEL` | Optional; defaults to `Xenova/paraphrase-multilingual-MiniLM-L12-v2` |
| RAG Render service | `ALLOWED_ORIGINS` | Optional; defaults to `*` |
| Existing Express Render service | `CHAT_URL` | `https://YOUR-RAG-SERVICE.onrender.com/chat` |
| Existing Express Render service | `CHAT_API_KEY` | Unset unless your RAG deployment adds authentication |
| Existing Express Render service | `REPORT_URL` | Preserve the current report endpoint |
| Expo build/runtime | `EXPO_PUBLIC_API_BASE_URL` | Existing Express backend base URL |
| Expo build/runtime | `EXPO_PUBLIC_CHAT_API_BASE_URL` | Omit or use the same existing Express backend base URL |

## Notes

- Retrieval uses multilingual sentence embeddings locally. If model download or inference fails, lexical retrieval remains available. If no relevant source passage is found, Groq still answers from general model knowledge; the response says that no app source was retrieved and advises verification.
- The answer includes retrieved source titles. Treat output as legal awareness information, not personalized legal advice; verify important details against current authoritative law and consult a qualified professional.
- The files in `data/` are the knowledge base. Add or update content there and restart/redeploy this service to rebuild its index. These files are a snapshot of the app's `constants/` content; copy over future app content changes when you want them included here.
