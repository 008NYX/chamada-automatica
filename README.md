# Escola Benedito Cláudio — Chamada por Reconhecimento Facial

Sistema web local de **chamada escolar**: o aluno apresenta o rosto na câmera e
ganha **presença** automaticamente. Inclui área do professor protegida por
senha, planilha de chamada, relatório de frequência e cadastro de alunos.

- **Backend:** Node.js + Express
- **Frontend:** HTML5 + CSS3 + JavaScript puro
- **IA:** `@vladmandic/face-api` (detecção facial, landmarks e embeddings de 128 dims)
- **Banco:** `database.json` (pronto para migrar para MongoDB)
- **Segurança:** senha do professor + cookie de sessão assinado (HMAC), sem libs extras

---

## 1. Estrutura

```
sistemaEscola/
├── server.js                  # Express: API, autenticação, chamada, arquivos
├── database.json              # Alunos, presenças e modelo de óculos
├── database.backup.json       # Cópia automática do estado anterior
├── .auth.json                 # Hash da senha do professor (gerado no 1º run)
├── package.json
├── README.md
├── views/                     # Páginas protegidas (não são servidas como estáticas)
│   ├── login.html             # Tela de login do professor
│   └── room.html              # Painel da sala (professor)
└── public/
    ├── index.html             # Cadastro + diagnóstico (professor)
    ├── simple.html            # Chamada: aluno apresenta o rosto
    ├── faces.html             # Lista de alunos cadastrados
    ├── train.html             # Treino do detector de óculos
    ├── css/style.css
    └── js/
        ├── api.js
        ├── glassesNet.js
        ├── glassesDetector.js
        ├── app.js             # Cadastro + diagnóstico
        ├── simple.js          # Chamada por reconhecimento
        ├── faces.js           # Lista de alunos
        ├── room.js            # Painel da sala
        └── train.js
```

### Telas

| URL | Quem usa | Descrição |
|-----|----------|-----------|
| `/simple.html` | Aluno | Câmera + "Rosto reconhecido / não reconhecido". Ao reconhecer, **registra presença**. |
| `/panel` | Professor (login) | Painel da sala (abre direto na 8D): chamada com **timer**, relatório e alunos. |
| `/room?classroom=8D` | Professor (login) | Mesmo painel (acesso direto por sala). |
| `/login` | Professor | Acesso ao painel. |
| `/` | Professor | Cadastro de aluno (captura facial) + diagnóstico. |
| `/faces.html` | Todos | Alunos cadastrados (remover só para professor). |
| `/train.html` | Professor | Treino do detector de óculos — **acesso direto pela URL** (não aparece nos menus). |

---

## 2. Instalar e rodar

```bash
npm install
npm start
# abra http://localhost:3000
```

Na primeira execução é criado o arquivo `.auth.json` e a **senha inicial do
professor** é impressa no terminal:

```
[auth] Senha inicial do professor: "benedito"
```

Entre em **http://localhost:3000/panel**. Para trocar a senha, defina a variável
de ambiente antes de subir o servidor (e apague `.auth.json`):

```bash
TEACHER_PASSWORD="umaSenhaForte" npm start
```

> `localhost` é contexto seguro, então a webcam funciona sem HTTPS.

---

## 3. Fluxo de uso

Por enquanto o sistema tem apenas a sala **8D**. A lista de salas fica em
`CLASSROOMS` no `server.js` — basta adicionar outras (ex.: `['8D', '8A', '6B']`)
para elas aparecerem em todas as telas. Cada aluno pertence a uma sala e cada
sala tem a sua própria chamada.

### Professor
1. Acesse `/panel` (senha) — abre direto o painel da **8D**.
2. No painel da sala, defina o **tempo máximo (minutos)** da chamada e clique em
   **Abrir chamada**. O botão certo aparece conforme o estado: se estiver
   **fechada**, aparece só **Abrir**; se estiver **aberta**, aparece só
   **Encerrar**. Há um **contador regressivo** do tempo restante.
3. Em `/simple.html`, selecione a sala. **A câmera só liga se a chamada daquela
   sala estiver aberta**; se estiver fechada, aparece "Chamada fechada".
4. O aluno apresenta o rosto; se ele for daquela sala, a presença é marcada
   automaticamente. O professor pode ajustar manualmente (Presente/Falta).
5. Aba **Relatório de frequência**: presenças, faltas, total de dias e
   porcentagem por aluno, com a planilha dia a dia (P/F).

### Funções do professor
- **Timer por chamada** (tempo máximo para se apresentar) com contador regressivo.
- **Exportar CSV** da chamada do dia e do relatório de frequência (abre no Excel).
- **Buscar aluno** por nome na aba Alunos.
- **Editar aluno**: Nome, Nº da chamada e Sala (mover de turma), além de remover.
- **Marcar Presente/Falta** manualmente quando necessário.

**Timer e estado "Aguardando":** enquanto o tempo estiver rolando, os alunos que
ainda não se apresentaram ficam como **Aguardando** — não contam como **falta**
nem como presença. Ao se apresentarem, viram **Presente**. Quando o tempo acaba,
a chamada **encerra sozinha** e quem não se apresentou passa a **Falta**.

> Só é possível marcar presença com a chamada **aberta e dentro do tempo**. Ao
> encerrar/expirar, novas marcações são recusadas (HTTP 409).

### Cadastrar aluno (professor)
1. Em `/` (após o login), inicie a câmera.
2. Posicione o rosto no guia e clique em **Cadastrar aluno**. Os dados faciais
   são **capturados na hora** (~1s) — não é preciso ficar na frente da câmera.
3. Preencha **Nome completo**, escolha a **Sala** (6A a 9E) e o **Número da
   chamada** (sem e-mail) e salve.

O cadastro e a remoção de alunos **exigem login** (a API responde 401 sem
sessão). Alunos cadastrados antes desta versão ficam sem sala — use o botão
**Sala** no painel para atribuir.

---

## 4. Segurança

- Login por senha do professor (`POST /api/auth/login`), verificada com
  `scrypt` + comparação em tempo constante.
- Sessão em cookie **HttpOnly**, `SameSite=Strict`, assinado com **HMAC-SHA256**
  e expiração de 8 horas.
- O HTML do painel (`/panel`) só é entregue com sessão válida; sem sessão,
  redireciona para `/login`.
- Endpoints de gerenciamento (criar/editar/remover aluno, abrir/encerrar
  chamada, marcar/desmarcar manualmente, relatório) exigem sessão.
- Endpoints públicos: listar alunos, planilha de hoje e **marcar presença**
  (usado pela tela da chamada).

> Para produção real, recomenda-se HTTPS, rate limiting e migrar a sessão para
> um store dedicado. Aqui o objetivo é um sistema escolar local simples e seguro.

---

## 5. API

Público:

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/config` | Nome da escola, data de hoje e lista de salas |
| GET | `/api/users` | Lista de alunos |
| GET | `/api/attendance/rooms` | Status (aberta/fechada) das salas hoje |
| GET | `/api/attendance/today?classroom=6A` | Planilha da chamada de hoje da sala |
| POST | `/api/attendance/mark` | Marca presença de hoje (`studentId`) — **só se a chamada da sala do aluno estiver aberta** |
| GET/PUT/DELETE | `/api/glasses-model` | Modelo de óculos treinado |

Professor (autenticado):

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/auth/me` | Estado da sessão |
| POST | `/api/auth/login` / `logout` | Entrar / sair |
| POST/PUT/DELETE | `/api/users[/:id]` | Gerenciar alunos (inclui `classroom`) |
| GET | `/api/attendance/sheet?classroom=6A&date=YYYY-MM-DD` | Planilha de uma data/sala |
| GET | `/api/attendance/sessions?classroom=6A` | Dias com chamada |
| GET | `/api/attendance/report?classroom=6A` | Presenças, faltas e % por aluno |
| POST | `/api/attendance/session/open` | Abrir chamada (`classroom`, `durationMin?` — 0 = sem limite) |
| POST | `/api/attendance/session/close` | Encerrar chamada (`classroom`) |
| PUT | `/api/attendance/record` | Marcar/desmarcar presença (`studentId`, `date`, `present`) |

---

## 6. Modelo de dados (`database.json`)

```jsonc
{
  "users": [
    {
      "id": "uuid",
      "name": "Nome completo",
      "classroom": "6A",
      "rollNumber": 7,
      "photo": "data:image/jpeg;base64,...",
      "descriptors": ["[...128 números...]"],
      "createdAt": "...", "updatedAt": "..."
    }
  ],
  "attendance": {
    "sessions": {
      "6A": {
        "2026-09-27": {
          "date": "2026-09-27",
          "classroom": "6A",
          "open": true,
          "openedAt": "...", "closedAt": null,
          "durationMin": 10,
          "expiresAt": "2026-09-27T...",
          "records": {
            "<id do aluno>": { "present": true, "at": "...", "by": "face" }
          }
        }
      }
    }
  },
  "glassesModel": { }
}
```

- Registro existente = **presente**. Sem registro, com a chamada **aberta e no
  tempo** = **aguardando** (não conta falta). Sem registro e chamada
  **encerrada/Expirada** = **falta**.
- **Porcentagem** = presenças ÷ dias com chamada **encerrada** (dias aguardando
  ainda não entram no cálculo).

---

## 7. Detecção de óculos

O `face-api.js` não tem classificador de óculos. O sistema usa:

1. **Heurística** (`glassesDetector.js`) como fallback — ajustável no painel de
   diagnóstico.
2. **Rede neural treinada** que tem prioridade quando existe. A página de treino
   fica em **`/train.html`** e é acessada **direto pela URL** (não há botão nos
   menus, para manter a interface simples). Você grava amostras COM/SEM óculos e
   treina até a validação chegar a 100%.

Se a heurística bloquear por engano, marque **"Estou sem óculos"** na tela de
cadastro, ou treine a rede.

---

## 8. Migração para MongoDB

A persistência está isolada em `readDb()` / `writeDb()` no `server.js`. Basta
trocar essas funções por operações de coleção e transformar `attendance.sessions`
em uma coleção `sessions` com um documento por data.
