# Rastreamento GBS — GPS para operações de busca e salvamento

Aplicativo web para o Corpo de Bombeiros Militar acompanhar, em tempo real, a posição e a trilha de
civis voluntários e militares durante operações de busca e salvamento, e enviar orientações direto
ao celular de cada participante.

- **`/militar.html`**: painel do bombeiro responsável (login obrigatório). Mapa, lista, trilhas, fichas,
  mensagens, equipe de responsáveis e a posição de cada responsável. Funciona no computador, no tablet e no celular.
- **`/civil.html#t=…`**: página do participante. Só abre com o link (ou QR Code) gerado pelo painel.
  O participante informa nome, CPF e celular; o encerramento do rastreamento é feito pelo responsável.

Tecnologias: HTML/CSS/JavaScript puros, Leaflet + OpenStreetMap, **Supabase** (Postgres, Auth,
Realtime) e **Vercel** (hospedagem e duas funções de servidor). Não há etapa de compilação.

---

## 1. Como funciona

```
 Celular do participante                Supabase                         Painel do militar
 ───────────────────────                ────────                         ─────────────────
 GPS (watchPosition)                                                     
   → fila local (localStorage)  ──RPC enviar_posicoes──►  posicoes   ──Realtime──►  mapa + trilhas
   ← alerta em tela cheia      ◄──Realtime / consulta──  mensagens  ◄──RPC enviar_mensagem──  comandos
   → confirmar_mensagem        ──────────────────────►  mensagens   ──Realtime──►  "confirmada"
   → sinal_vida (a cada 15 s)  ──────────────────────►  participantes ─Realtime──►  conectado / instável
```

- **Tempo real**: o painel recebe as mudanças pelo Supabase Realtime. Se o tempo real cair, o painel
  avisa ("Atualizando a cada 8 s") e passa a conferir o servidor periodicamente, buscando só as
  posições novas. Nada se perde.
- **Sem internet no celular**: as posições ficam guardadas no aparelho e são enviadas quando a
  conexão volta. Cada ponto tem um identificador único, então o reenvio **não duplica** pontos.
- **Trilhas**: os pontos são ordenados pelo horário do GPS (mesmo os que chegam atrasados). Intervalos
  maiores que 5 minutos sem pontos **não são ligados por uma reta** (para não sugerir que a área foi
  percorrida) e pontos com precisão pior que 100 m não entram na trilha.

### Estados mostrados no painel

| Indicador | Significado |
|---|---|
| ● verde **Conectado** | contato do celular nos últimos 45 s |
| ● amarelo **Sinal instável** | último contato entre 45 s e 2 min |
| ● vermelho **Sem atualização** | sem contato há mais de 2 min (a última posição continua no mapa, marcada como antiga) |
| Selo âmbar **Pediu para sair** | o participante solicitou o encerramento; o rastreamento continua até o responsável decidir |
| **Saída liberada às …** | o responsável liberou; o celular parou de enviar |
| Marcador tracejado e desbotado | posição com mais de 2 min: **não é a localização atual** |
| Militar = quadrado **M** vermelho, trilha contínua · Civil = círculo **C** verde, trilha tracejada · Responsável = losango **R** ciano, trilha pontilhada | a informação não depende só da cor |
| Anel amarelo | o participante respondeu "Preciso de ajuda" |

### Estados das mensagens

**Enviada** (gravada no servidor) → **Recebida pelo aparelho** (o celular do participante recebeu) →
**Confirmada** (o participante tocou em confirmar; no comando CONFIRME ele responde "Estou bem" ou
"Preciso de ajuda"). Se o participante estiver sem conexão, o painel avisa que a mensagem só será
entregue quando ele reconectar. Um pedido de ajuda destaca o participante em amarelo na lista e no
mapa e toca um alarme no painel.

### Vários responsáveis na mesma operação

- Quem cria a operação pode adicionar outros responsáveis pelo e-mail, no botão **Equipe** (só quem
  já tem acesso ao painel). Qualquer responsável da operação também pode adicionar; **só o criador remove**.
- Todos veem o mesmo mapa, os mesmos participantes e mensagens, e podem enviar orientações (a
  mensagem mostra ao participante quem a enviou).
- **Minha posição** (botão no topo do painel): o responsável compartilha a própria localização.
  Os outros responsáveis o veem como um losango ciano **R**; civis e militares de campo **não** veem.
- Pela ficha de outro responsável é possível mandar ATENÇÃO, CONFIRME ou mensagem livre; ela chega
  como alerta no painel dele, com confirmação de leitura.

### Encerramento da participação

O participante **não tem botão para parar** o rastreamento. Ele toca em **Solicitar encerramento**
(pode informar o motivo); o painel toca um alarme e destaca "Pediu para sair". Na ficha, o
responsável escolhe **Liberar saída** (o celular para de enviar e mostra "Saída liberada") ou
**Pedir para continuar** (o pedido é cancelado e o participante recebe uma mensagem). Enquanto
aguarda, a localização continua sendo enviada.

> Nenhum site consegue impedir que alguém feche o navegador ou desligue o GPS do próprio celular.
> Se isso acontecer, o painel mostra "Sinal instável" e depois "Sem atualização" com a última
> posição marcada como antiga, e a página avisa antes de ser fechada.

---

## 2. Estrutura dos arquivos

```
rastreamento-sar/
├── public/                     ← site publicado pelo Vercel
│   ├── militar.html            painel do responsável
│   ├── civil.html              página do participante
│   ├── sw.js                   service worker mínimo (notificações no Android)
│   ├── css/estilos.css         estilos (alto contraste, botões grandes, responsivo)
│   └── js/
│       ├── comunicacao.js      cliente Supabase, chamadas ao servidor, erros, relógio, formatação
│       ├── interface.js        avisos e caixas de confirmação
│       ├── militar.js          lógica do painel
│       └── civil.js            lógica do participante (GPS, fila offline, mensagens)
├── api/
│   ├── config.js               entrega ao navegador só a URL e a chave PÚBLICA (de variáveis de ambiente)
│   ├── limpeza.js              limpeza diária dos dados vencidos (usa a chave SECRETA, só no servidor)
│   └── responsaveis.js         cria login e redefine senha de responsáveis (só administradores; chave SECRETA)
├── supabase/schema.sql         tabelas, regras de segurança (RLS), funções e tempo real
├── vercel.json                 diretório publicado, agendamento da limpeza e cabeçalhos de segurança
├── .env.example                nomes das variáveis de ambiente
└── package.json
```

---

## 3. Configurar o Supabase (≈ 10 minutos)

1. Crie uma conta em <https://supabase.com> e clique em **New project**. Escolha a região
   **South America (São Paulo)** para menor latência. Guarde a senha do banco.
2. Abra **SQL Editor → New query**, cole **todo** o conteúdo de `supabase/schema.sql` e clique em
   **Run**. Deve terminar sem erros.
   **Já tinha publicado uma versão anterior?** Execute o `schema.sql` novo do mesmo jeito: ele
   atualiza tabelas, funções e regras **sem apagar** operações nem dados existentes.
3. Ative o ingresso dos participantes: **Authentication → Sign In / Providers** (ou **Providers**) →
   ligue **Allow anonymous sign-ins** → **Save**.
   *Cada celular recebe uma identidade anônima; ela só serve para ingressar com o token do link.*
4. **Aumente o limite de ingressos anônimos**: em **Authentication → Rate Limits**, o padrão é
   **30 por hora por endereço IP**. Numa base de operações, muitos voluntários usam a mesma rede
   (Wi-Fi ou operadora com IP compartilhado), então aumente para, por exemplo, 300.
5. **Só na primeira instalação** — crie o **primeiro** responsável (ele será o administrador):
   **Authentication → Users → Add user → Create new user**, informe e-mail e senha forte e marque
   **Auto Confirm User**.
6. **Autorize** esse primeiro usuário. No **SQL Editor**, troque o e-mail e o nome e execute:

   ```sql
   insert into public.responsaveis (user_id, nome)
   select id, 'Sgt BM Fulano de Tal' from auth.users where email = 'fulano@cbm.exemplo.gov.br';
   ```

   O primeiro responsável cadastrado vira **administrador** automaticamente. **Todos os outros
   responsáveis são cadastrados pelo próprio painel** (tela **Responsáveis**, seção 6), sem
   voltar ao Supabase. Se o banco já existia, o responsável mais antigo vira administrador.
7. Copie as chaves em **Project Settings → API Keys** (ou **Data API**):
   - **Project URL** (ex.: `https://abcd1234.supabase.co`);
   - **Publishable key** (`sb_publishable_…`) — ou, em projetos antigos, a **anon key**;
   - **Secret key** (`sb_secret_…`) — ou, em projetos antigos, a **service_role key**. **Nunca** coloque esta em arquivos do site.
8. (Conferência) Em **Database → Publications → supabase_realtime**, as tabelas `participantes`,
   `posicoes` e `mensagens` devem aparecer marcadas. O `schema.sql` já faz isso.

> O cadastro aberto de usuários por e-mail pode ficar como está: o acesso ao painel depende
> **exclusivamente** da tabela `responsaveis`, que só um administrador altera (pelo painel).

---

## 4. Publicar no Vercel (≈ 5 minutos)

### Opção A — pelo site (recomendada)

1. Envie a pasta `rastreamento-sar` para um repositório no GitHub (pode ser privado).
2. Em <https://vercel.com/new>, importe o repositório.
   - **Framework Preset**: `Other` · **Root Directory**: a pasta do projeto · sem comando de build.
3. Em **Environment Variables**, cadastre (valores do passo 3.7):

   | Nome | Valor |
   |---|---|
   | `SUPABASE_URL` | Project URL |
   | `SUPABASE_PUBLISHABLE_KEY` | chave publishable (ou anon) |
   | `SUPABASE_SECRET_KEY` | chave secret (ou service_role) — usada na limpeza diária e no cadastro de responsáveis |
   | `CRON_SECRET` | um texto aleatório longo — gere com `openssl rand -hex 32` |

4. Clique em **Deploy**.

### Opção B — pela linha de comando

```bash
npm i -g vercel
cd rastreamento-sar
vercel                      # cria o projeto (aceite os padrões)
vercel env add SUPABASE_URL production
vercel env add SUPABASE_PUBLISHABLE_KEY production
vercel env add SUPABASE_SECRET_KEY production
vercel env add CRON_SECRET production
vercel --prod
```

> Ao mudar uma variável de ambiente, faça um novo deploy (**Deployments → Redeploy**).

---

## 5. Os dois links finais

Depois do deploy, o Vercel mostra o domínio do projeto, por exemplo `https://rastreamento-sar.vercel.app`.

1. **Painel do militar**: `https://rastreamento-sar.vercel.app/militar.html`
   (o endereço raiz `/` também redireciona para ele). Faça login e crie a operação.
2. **Link do participante**: é gerado **por operação**, no botão **Convidar** do painel. Há duas abas:
   - **Link para CIVIS** — `https://rastreamento-sar.vercel.app/civil.html#t=<token de 64 caracteres>`
     Quem entra por ele sempre aparece como **civil**.
   - **Link para MILITARES** — outro token; permite escolher **militar** (ou civil). Compartilhe só com militares.

   Cada aba tem **Copiar**, **Compartilhar** (WhatsApp etc., no celular) e **QR Code** para leitura na base.

Os links de participante **não dão acesso ao painel**, deixam de funcionar quando a operação é
encerrada, e o token fica após o `#` (não é enviado aos servidores nem aparece em registros de acesso).

---

## 6. Uso em campo

**Cadastro de responsáveis (administrador)**: na tela de operações, botão **Responsáveis**.
- **Cadastrar**: nome/posto, e-mail (será o login) e senha provisória (o botão **Gerar** cria uma
  senha aleatória). O login é criado na hora, sem e-mail de confirmação. O painel mostra os dados de
  acesso para copiar e repassar ao colega. Marque **Também é administrador** se ele puder cadastrar outros.
- **Redefinir senha** (quem esqueceu), **Desativar/Reativar acesso** (corta ou devolve o acesso na
  hora; o histórico das operações é mantido), **Tornar/Tirar administrador** e **Renomear**.
- Um administrador não consegue desativar nem tirar o próprio acesso de administrador (evita
  ficar sem nenhum administrador).
- **Minha conta** (todos os responsáveis): trocar a própria senha.


**Responsável**: login → **Nova operação** (nome/código e política de retenção) → **Convidar** →
acompanhar o mapa. Na lista: **◎** centraliza o participante, **Trilha** mostra/oculta a trilha dele.
**Mostrar trilhas / Ocultar trilhas** atuam em todos. Toque no nome ou no marcador para abrir a
**ficha** (dados, precisão, histórico de posições, comandos e estado das mensagens). Os comandos
RETORNE, ATENÇÃO, MUDE A ROTA e PARE pedem confirmação antes do envio, e o texto pode ser complementado
(ex.: "Retorne ao PC 2"). Botões do mapa: **⤢** enquadra todos, **Aa** mostra/oculta os nomes, e o
seletor de camadas troca entre Mapa, Relevo e Satélite.

**Participante**: abre o link → digita nome, **CPF** e **celular** → **INICIAR RASTREAMENTO** → permite
a localização. CPF e celular são obrigatórios para civis e opcionais para militares (link de
militares); o CPF é conferido pelos dígitos verificadores. Deve manter a página aberta e a tela
ligada (a opção "Manter a tela ligada" já vem marcada). Para sair, toca em **Solicitar encerramento**.

**Na ficha do participante**, o CPF aparece mascarado (`***.456.789-**`, com o botão "mostrar") e
o celular tem link para **ligar** direto.

**Encerrar**: **Encerrar operação** → os celulares param de enviar e mostram "Operação encerrada".
Os dados são apagados conforme a retenção escolhida:

| Retenção escolhida | O que acontece |
|---|---|
| Ao encerrar | participantes, posições, trilhas e mensagens são apagados **no mesmo instante** |
| 24 h / 3 / 7 / 30 dias | os dados ficam disponíveis para consulta e são apagados pela limpeza diária após o prazo |
| Qualquer uma | o botão **Apagar dados agora** apaga antecipadamente |

Salvaguardas: operações esquecidas abertas por mais de 30 dias são encerradas automaticamente, e
identidades anônimas sem participação há mais de 7 dias são removidas. A limpeza roda todo dia às
07:00 UTC (04:00 de Brasília) pelo Vercel Cron, que chama `/api/limpeza` com o `CRON_SECRET`.

---

## 7. Segurança e privacidade

| Requisito | Como foi implementado |
|---|---|
| Consentimento explícito | o GPS só é solicitado depois do toque em INICIAR, com aviso claro sobre localização, CPF e celular; o encerramento é pedido ao responsável, que libera a saída |
| Dados pessoais (LGPD) | CPF e celular são vistos **só pelos responsáveis da operação**, validados no servidor, guardados só com dígitos, exibidos mascarados por padrão e **apagados junto com a operação** pela política de retenção. Recomenda-se registrar a finalidade (identificação e contato em operação de busca) no controle de tratamento de dados da corporação |
| Cadastro de responsáveis | só administradores ativos; a criação do login e a troca de senha passam pela função de servidor `/api/responsaveis`, que confere o administrador com o login dele e só então usa a chave secreta (que nunca vai ao navegador). Desativar um responsável corta o acesso a todas as operações na hora |
| Vários responsáveis | o acesso a cada operação vale para o criador e para quem ele (ou a equipe) adicionar; todos precisam continuar cadastrados em `responsaveis`. Remover alguém da equipe corta o acesso na hora |
| Acesso restrito ao painel | login por e-mail/senha **e** cadastro na tabela `responsaveis`; o link público não concede acesso |
| Ingresso seguro | tokens aleatórios de 64 caracteres hexadecimais (244 bits), separados para civis e militares |
| Tipo civil/militar | decidido **no servidor** pelo token usado; alterar o navegador não transforma um civil em militar |
| Autorização no backend | nenhuma tabela aceita gravação direta do navegador; toda escrita passa por funções que validam dono, operação ativa e dados |
| Separação entre operações | RLS: o responsável só lê as operações em que está na equipe; o participante só lê o próprio cadastro e as próprias mensagens |
| Coordenadas não públicas | **nenhum participante lê posições**, nem as próprias, nem as dos responsáveis; só os responsáveis da operação |
| Validação de dados | latitude/longitude/precisão/horário validados no servidor; lote máximo de 500 pontos; texto de mensagem até 500 caracteres; limite de 60 mensagens por minuto e de 300 participantes por operação |
| Segredos | só a chave **pública** chega ao navegador (via `/api/config`, lida de variável de ambiente). A chave secreta fica no servidor (`/api/limpeza`) |
| Cabeçalhos | CSP restritiva, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` (envia só o domínio do site, exigido pelo OpenStreetMap; o token do link fica após o `#` e nunca é enviado), `Permissions-Policy` (geolocalização só no próprio site) |
| Bibliotecas externas | carregadas com versão fixa e verificação de integridade (SRI) |

**Domínio próprio no Supabase**: se usar um domínio personalizado no Supabase, acrescente-o ao
`connect-src` da política CSP em `vercel.json`.

---

## 8. Limitações dos navegadores e alternativas

Estas limitações são da plataforma web móvel, não do código, e estão comunicadas na própria página do participante.

1. **Tela apagada / outro aplicativo aberto — não é possível com uma página web.** Quando a página
   sai da tela, o Chrome do Android (e o Safari do iPhone) **param de entregar o GPS** para ela, e
   não existe permissão que um site possa pedir para mudar isso. Por isso o rastreamento contínuo
   em segundo plano **exige um aplicativo instalado** (ver a proposta abaixo). Na versão web:
   - a página pede para **manter a tela ligada** (Screen Wake Lock API, suportada no Chrome para Android);
   - ao voltar para a página, a posição é retomada, a fila é enviada e o participante vê um aviso
     informando por quanto tempo a página ficou pausada;
   - o painel nunca apresenta uma posição antiga como atual: mostra o horário e marca o participante
     como instável ou sem atualização.
2. **Gravação offline** só acontece enquanto a página estiver aberta e ativa; não há gravação com a página fechada.
3. **Mensagens com a página fechada** não chegam. Com a página aberta em segundo plano, o celular
   vibra, toca um alerta e, se o participante tocou em **Ativar alertas de mensagem**, mostra uma
   notificação, desde que o navegador ainda esteja executando a página. Para entrega garantida com a
   página fechada seria necessário **Web Push** (servidor com chaves VAPID e assinatura de push),
   e mesmo assim o rastreamento continuaria limitado.
4. **iPhone (Safari)**: a localização com a tela bloqueada é ainda mais restrita, e as notificações
   web só funcionam com o site instalado na tela inicial (iOS 16.4+).
5. **Precisão**: depende do aparelho e do céu aberto. Em mata fechada ou entre prédios, ±20–50 m é comum.

### Solução para segundo plano: aplicativo Android (rastreamento com a tela apagada)

Para o rastreamento continuar com a tela apagada ou com outro aplicativo aberto, o caminho é um
aplicativo Android instalado no celular do participante, **reaproveitando todo este backend**
(mesmas tabelas, funções, regras de segurança e o mesmo painel; o participante entra pelo mesmo
link/QR Code e informa nome, CPF e celular):

- **Foreground Service** do tipo `location` com notificação permanente ("Rastreamento GBS ativo"),
  que o Android não encerra em segundo plano;
- **FusedLocationProviderClient** (Google Play Services), com intervalo de 5–10 s e prioridade de alta precisão;
- fila local em **Room/SQLite** e envio com **WorkManager** quando houver rede (mesma RPC `enviar_posicoes`, com o mesmo identificador por ponto para não duplicar);
- **Firebase Cloud Messaging** (prioridade alta) para entregar os comandos mesmo com o app fechado,
  disparado por um gatilho no banco ao inserir em `mensagens`;
- permissões `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE_LOCATION` e
  `POST_NOTIFICATIONS`, além de orientação para retirar o app da otimização de bateria.
  Para publicar na Play Store, o uso de localização em segundo plano passa por declaração e revisão do Google. Para uso interno, o app também pode ser distribuído direto (APK ou gerenciamento de dispositivos).

---

## 9. Roteiro de teste com celulares reais (critérios de conclusão)

Use dois celulares Android com Chrome atualizado e dados móveis (de preferência um em Wi-Fi e outro em 4G).

| # | Teste | Resultado esperado |
|---|---|---|
| 1 | Militar faz login e cria a operação | painel abre e mostra o convite com QR Code |
| 2 | Civil lê o QR Code em outro celular, digita o nome e toca INICIAR | o celular pede permissão; após aceitar, mostra "RASTREAMENTO ATIVO" |
| 3 | Aguardar até 20 s | o marcador verde **C** aparece no mapa, na posição real |
| 4 | Civil caminha por 2–3 minutos | a trilha tracejada verde é desenhada |
| 5 | Observar o painel | horário "há X s" e posição atualizam sozinhos |
| 6 | Tocar em **Trilha** na lista; depois **Ocultar trilhas** e **Mostrar trilhas** | a trilha some/volta; o marcador continua andando e o histórico da ficha continua crescendo |
| 7 | Tocar no nome ou no marcador | abre a ficha com coordenadas, precisão, horários e histórico |
| 8 | Na ficha, enviar **PARE** | o operador confirma o envio; o painel mostra "Enviada" |
| 9 | No celular do civil | alerta em tela cheia com vibração; ao tocar **CONFIRMAR**, o painel mostra "Recebida pelo aparelho" e depois "Confirmada às …" |
| 10 | Pôr o celular do civil em modo avião por 1–2 min, andando | o civil vê "Sem internet · N posições guardadas"; o painel passa a "Sinal instável" e depois "Sem atualização", com o marcador desbotado |
| 11 | Desligar o modo avião | os pontos guardados chegam, a trilha é completada sem duplicar e o estado volta a "Conectado" |
| 12 | No celular do civil, abrir `/militar.html` | pede login; com a sessão do civil não há acesso ao painel nem às posições |
| 13 | Encerrar a operação | o celular mostra "Operação encerrada"; com retenção "Ao encerrar", os dados somem na hora; com prazo, somem após a limpeza diária |
| 14 | No celular do civil, tocar em **Solicitar encerramento** | o painel toca alarme e mostra "Pediu para sair"; o rastreamento continua; ao **Liberar saída**, o celular mostra "Saída liberada" |
| 15 | Adicionar um segundo responsável em **Equipe** e ligar **Minha posição** nos dois painéis | cada um vê o outro no mapa (losango ciano); mensagem de um para o outro chega como alerta |
| 16 | Abrir o painel no celular (em pé e deitado) e no tablet | mapa, lista e ficha ficam utilizáveis, sem rolagem lateral |

### Testes já realizados no desenvolvimento

- **Backend (153 verificações)**: o `schema.sql` foi executado num PostgreSQL 16 com PostgREST, usando o
  supabase-js real, inclusive **por cima de um banco da versão anterior** (atualização sem perda).
  Foram verificadas as regras de RLS e de permissão (intruso, outro responsável, participante de
  outra operação, acesso sem login), a validação e a deduplicação de posições, o tipo civil/militar
  decidido pelo servidor, o ciclo de mensagens, o cadastro de responsáveis pelo painel (só
  administradores, senha provisória, redefinir senha, desativar/reativar, proteção contra ficar sem
  administrador), a equipe de responsáveis (adicionar, remover,
  isolamento), a posição e as mensagens entre responsáveis, a validação de CPF e celular, o pedido
  de encerramento (recusar e liberar), o encerramento com e sem retenção e a limpeza diária.
- **Ponta a ponta (71 verificações)**: no Chromium, com o painel no computador, no tablet e no
  celular (em pé e deitado), dois celulares Android simulados com GPS em movimento e dois
  responsáveis na mesma operação. Cobre todos os itens da tabela acima, a queda de internet com
  recuperação sem duplicar pontos e a política CSP real do `vercel.json` (sem nenhum erro de
  JavaScript ou de segurança).
- **Administração no navegador (20 verificações)**: cadastro pelo painel, primeiro acesso com a senha
  provisória, troca de senha em "Minha conta", redefinição, desativação (a pessoa perde o acesso na
  hora) e reativação, no computador e no celular.
- **Não testado ainda**: o Supabase Realtime real (no teste local ele estava indisponível de
  propósito, o que validou o modo de contingência) e o **comportamento em celulares físicos**, como
  GPS real, tela bloqueada e economia de bateria. Faça o roteiro acima antes do uso operacional.

---

## 10. Custos e cuidados operacionais

- **Supabase Free** e **Vercel Hobby** atendem testes e operações pequenas. Cada participante gera
  cerca de 1 ponto a cada 5–30 s (~100 bytes): 50 pessoas por 8 h somam cerca de 150 mil pontos (~30 MB).
- **Atenção**: projetos no plano gratuito do Supabase são **pausados após uma semana sem uso**. Para
  uso operacional, confira no painel do Supabase se o projeto está ativo antes de cada operação,
  ou considere o plano Pro, que não pausa.
- O plano Hobby do Vercel é para uso não comercial; para uso institucional, avalie o plano Pro.
- Os mapas usam os servidores públicos do OpenStreetMap, OpenTopoMap e Esri, que têm políticas de uso
  justo. Para uso intenso, contrate um provedor de mapas.
- Sem sinal de celular não há rastreamento ao vivo, e nenhuma tecnologia web contorna isso. Em áreas
  remotas, a fila offline completa a trilha quando o participante volta a ter sinal.
