# frequencia — sala de voz/video P2P com compartilhamento de tela

App simples tipo "Discord 2", so o essencial: entrar num canal, falar, ouvir,
ver a camera de quem quiser e compartilhar tela sem travar feito acontece
as vezes no Google Meet (aqui o video passa direto entre os participantes,
sem servidor no meio reprocessando).

## Como funciona por baixo dos panos

- **Backend** (`server.js`): so cuida da "apresentacao" entre os participantes
  (WebRTC signaling) via Socket.io. Ele NAO recebe audio/video/tela — isso
  tudo trafega direto entre os navegadores (peer-to-peer). Por isso o
  backend e levissimo e cabe tranquilo em qualquer plano gratuito.
- **Frontend** (`public/`): HTML/CSS/JS puro, sem build, sem framework.

Topologia **mesh**: cada participante se conecta direto com todos os outros.
Funciona muito bem para grupos de amigos (ate uns 5-6 numa call ao mesmo
tempo). Passando bastante disso, cada pessoa precisa mandar sua camera pra
todo mundo ao mesmo tempo e a qualidade pode cair — igual qualquer app que
usa esse modelo. Pra grupo de amigos, é o suficiente e é de graça.

## Rodando na sua maquina

Precisa ter o [Node.js](https://nodejs.org) instalado (versao 18 ou mais nova).

```bash
npm install
npm start
```

Abra `http://localhost:3000` no navegador. Para testar com "duas pessoas",
abra em uma aba normal e outra anonima (ou em outro navegador).

## Colocando no ar de graça pra mandar pros seus amigos

A forma mais simples e gratuita: **Render.com** (tem plano free para apps
Node com WebSocket, que e exatamente o que esse projeto usa).

1. Crie uma conta em https://render.com (da pra logar com GitHub).
2. Suba essa pasta pra um repositorio no GitHub (pode ser privado).
3. No painel do Render: **New +** → **Web Service** → conecte o repositorio.
4. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Clique em criar. Em alguns minutos o Render te da uma URL tipo
   `https://seu-app.onrender.com` — e so mandar esse link pros seus amigos.

Detalhe do plano free do Render: se o app ficar uns 15 minutos sem uso, ele
"dorme" e demora uns segundos pra acordar na proxima visita. Pra um grupo de
amigos isso costuma ser tranquilo (so o primeiro a entrar espera um
pouquinho). Alternativas gratuitas parecidas: Railway e Fly.io — o passo a
passo e bem similar (build/start command iguais).

## Sobre chamadas que nao conectam (rede fechada / 4G/CGNAT)

Coloquei no codigo (`ICE_SERVERS` em `public/client.js`) um servidor TURN
publico de teste (Open Relay Project) alem do STUN do Google — isso ajuda
quando a internet de alguem bloqueia conexao direta. E gratuito, mas e um
servico compartilhado publicamente, entao pode as vezes ficar sobrecarregado.
Se algum amigo especifico nunca conseguir conectar, crie uma conta gratuita
em https://www.metered.ca/tools/openrelay/ e troque as credenciais no topo
do `client.js` pelas suas — o limite gratuito de la costuma sobrar pra um
grupo de amigos.

## O que tem no app

- Tela de entrada: nome + nome do canal (ou gerar um canal aleatorio).
- Grade de video com todo mundo que estiver no canal.
- Botoes: mutar microfone, ligar/desligar camera, compartilhar tela, sair.
- Copiar link do canal pra mandar direto pro grupo.
- Se alguem nao tiver camera, entra so com audio numa "bolinha" com o nome.

## Estrutura de arquivos

```
callroom/
├── server.js        # backend (Express + Socket.io)
├── package.json
└── public/
    ├── index.html
    ├── style.css
    └── client.js     # toda a logica de WebRTC (mesh + compartilhar tela)
```
