# AgroLinha — Documento do Projeto (v2 — pós-tribunal)
*(nome provisório — pode mudar)*

> Ferramenta web para o **agrônomo/consultor** planejar **linhas de plantio e pulverização**, calcular **economia de insumo em R$** e exportar para o GPS/piloto automático da máquina. Inspirado no "GoFarm".

## ⚠️ Restrições oficiais do projeto
- **Orçamento: R$ 0.** Só ferramentas gratuitas / free tier. Nada de gastar dinheiro.
- **Natureza: projeto de APRENDIZADO e PORTFÓLIO**, não negócio validado. Pior caso aceitável = um item forte de portfólio. Vira negócio só se a validação (Fase 0) der certo.
- **Único custo real = tempo do Victor.**

## 🏛️ Veredito do tribunal (2026-06-23) — resumo
Estressado por crítico + defensor + juiz + 4 personas. Consenso:
1. **"Gerar linha A-B reta" está morto** — o monitor da máquina já faz de graça. Não é o produto.
2. **Cliente certo = AGRÔNOMO/CONSULTOR autônomo** (não produtor pequeno, não fazendão). Ele é também o **canal de distribuição** (leva pra dezenas de fazendas).
3. **Export é vida ou morte. KML NÃO vira linha-guia** na maioria dos monitores → **Shapefile completo** na estrutura de pasta da marca. Validar num monitor REAL antes de codar.
4. **Produto real = planejamento de escritório + economia de insumo em R$**, não "desenhar linha".
5. Falta vivência: **"espaçamento entre passadas"** (não "largura do implemento"); **cabeceira entra no MVP**.

---

## 1. O problema
No agro mecanizado, trator/plantadeira/pulverizador rodam com piloto automático — mas alguém precisa **planejar as linhas-guia** e saber **quanto de insumo** aquilo vai consumir. O traçado reto na hora o próprio monitor faz; o que falta é **planejar a fazenda inteira antes**, comparar traçados e antecipar desperdício (sobreposição/falha = semente, defensivo e diesel jogados fora).

## 2. A solução
App web (de escritório) onde o **consultor**:
1. **Importa o talhão** que ele já tem (KML/Shapefile) ou desenha no satélite.
2. Informa **espaçamento entre passadas** + linha de referência (A-B).
3. Gera as linhas + **cabeceiras**, recortadas ao talhão.
4. Vê **métricas em R$**: nº de passadas, área, sobreposição/falha → "economia de X sacas / Y litros".
5. **Exporta Shapefile** (validado) pro pen drive → GPS da máquina.

## 3. Público-alvo — TRAVADO
**O agrônomo/consultor autônomo.** Atende dezenas de fazendas, já cobra planejamento como serviço, paga ferramenta de trabalho sem drama, e é o **canal** que dá acesso ao produtor (que o dev não acessa sozinho).
- ❌ Produtor pequeno: paga pouco, desconfia, churn alto. (no máximo cliente indireto, via consultor)
- ❌ Fazendão grande: já tem ecossistema RTK integrado; ciclo de venda longo. **Não tentar.**

## 4. Proposta de valor / diferencial
- **Rápido e confiável no export** (não "fácil e barato" — o consultor não é leigo).
- **Import de talhão** que ele já tem (não redesenhar tudo).
- **Múltiplas fazendas** num lugar só.
- **Economia mostrada em R$/sacas/litros**, não em "% de sobreposição".
- Em português, com suporte próximo (vantagem real enquanto é pequeno).

## 5. Funcionalidades

### MVP (revisado pelo tribunal)
- [ ] **Importar talhão** (KML/GeoJSON/Shapefile) — *prioridade nº 1 do consultor*
- [ ] Mapa satélite (free tier) + desenhar/editar talhão (alternativa ao import)
- [ ] **Múltiplas fazendas / múltiplos talhões** por projeto
- [ ] Definir **espaçamento entre passadas** + linha A-B reta
- [ ] Gerar linhas paralelas recortadas ao talhão
- [ ] **Cabeceiras (headlands)** automáticas — *movido do "futuro" pro MVP*
- [ ] Métricas em **R$**: passadas, área (ha), sobreposição/falha, economia estimada
- [ ] **Exportar Shapefile completo** (.shp/.shx/.dbf/.prj) na estrutura de pasta da marca
- [ ] Salvar projetos (login simples)

### Futuro (fase 2+)
- [ ] Export **ISOXML (ISOBUS)**
- [ ] Linhas em **curva de nível** (precisa de dados de elevação) — muita gente em MT precisa
- [ ] Formatos de marca (Trimble .ab, John Deere) / integração API
- [ ] Mapas de prescrição (taxa variável)
- [ ] Modo offline / app mobile

## 6. Fluxo do usuário (consultor)
`Login → fazenda do cliente → importar talhão → espaçamento + A-B → gerar linhas + cabeceira → ver economia em R$ → exportar Shapefile → pen drive → GPS da máquina`

## 7. Stack técnica (tudo grátis / free tier)
- **Frontend:** React + Vite + TypeScript
- **Mapa:** MapLibre GL (open source) + tiles de satélite no **free tier** (Esri World Imagery / Mapbox grátis — cuidar do limite)
- **Geometria:** Turf.js (linhas/clipping) + proj4 (UTM; em MT geralmente fuso 21S/22S — confirmar)
- **Export Shapefile:** lib JS (ex.: shp-write) gerando os 4 arquivos + .prj correto
- **Dados:** Supabase (free tier)
- **Deploy:** Vercel (free tier)
- *Nenhuma linguagem nova pro Victor; nenhum custo.*

## 8. O coração técnico — geração das linhas
1. Polígono do talhão (WGS84) → converter para **UTM** (metros, fuso de MT).
2. Da linha A-B, calcular o **rumo**.
3. Gerar linhas paralelas com **espaçamento entre passadas** (offset de retas — geometria resolvida no caso de talhão limpo).
4. **Recortar** cada linha ao polígono (clipping) + gerar **cabeceira** (faixa de manobra na borda).
5. Métricas e conversão de volta p/ lat-long.

**Riscos técnicos reais:** offset/clipping em talhão irregular; cabeceira correta; **.prj com a projeção certa** (se errar, a linha aparece no lugar errado no GPS).

## 9. Exportação — o ponto de vida ou morte (pesquisado 2026-06-23)
**Realidade:** NÃO existe um formato universal de linha-guia. Mercado fragmentado (Trimble, John Deere, Topcon, Stara...). Dois caminhos reais:
- **Shapefile** (.shp/.shx/.dbf/.prj): "esperanto" pra **contorno de talhão**, amplamente lido. MAS pra virar **linha-guia AB** muitos monitores NÃO importam shapefile direto — precisa conversão (ex.: existe o "GLC Guidance Line Creator" só pra converter shapefile → linha John Deere). Bom pra contorno e Trimble; não é bala de prata pra guia.
- **ISOXML** (`TASKDATA.XML`, padrão ISOBUS): o mais próximo de um **padrão real** de troca entre marcas. **John Deere Gen4 importa ISOXML direto via pen drive.** É o alvo estratégico pra linha-guia (sobe do "futuro" pra prioridade).
- 💡 **John Deere tem API de guidance lines** (`developer.deere.com`) → dá pra mandar a linha **via API**, sem arquivo/pen drive, no caso JD. Ótimo pra app web.

**Plano de export do MVP:** gerar **Shapefile** (demonstrável/universal pra contorno) **e mirar ISOXML** como formato de guia de verdade. **KML só pra visualização**, nunca como guia. Offline via pen drive FAT32 quando for arquivo.
**Regra de ouro:** confirmar marca/modelo/firmware do monitor real (via irmão) antes do exportador final — firmware muda o que importa.

## 10. Roadmap por fases
- **Fase 0 — Validação (custo R$ 0, antes de codar):**
  - ✅ **Validador de domínio = IRMÃO do Victor** (já trabalhou com planejamento de linhas/agric. de precisão). Maior risco (falta de domínio) resolvido.
  1. Conversar com o irmão: marca/modelo dos monitores, formato que funciona como linha-guia, e conseguir **1 arquivo de export real**.
- **Fase 1 — Protótipo geométrico:** importar talhão + gerar linhas retas + cabeceira + métricas em R$ (sem login/export). *Já vale como portfólio.*
- **Fase 2 — MVP usável:** export Shapefile validado + múltiplas fazendas + login.
- **Fase 3 — Diferenciais:** ISOXML, curva de nível, formatos de marca.

## 11. Modelo de negócio (só se virar negócio)
- **Assinatura do CONSULTOR**, ilimitada em fazendas: **R$ 80–300/mês** (faixa que o próprio consultor citou). **Nunca por hectare** (puniria quem tem muitos clientes = o melhor usuário).
- *Obs.: Victor não vai investir dinheiro; monetização é hipótese pós-validação, não meta inicial.*

## 12. Riscos (vivos)
- **Domínio:** Victor não é agrônomo → mitigar com o consultor-conselheiro (Ação Fase 0).
- **Export:** fragmentação de formatos por marca → começar com 1 só, validado.
- **Execução:** histórico de abandonar projetos → tratar como portfólio (entregável de cada fase já tem valor sozinho).
- **Geometria:** casos irregulares são difíceis → MVP só em talhão limpo.

## 13. Próximos passos imediatos
1. Fase 0 — Ação 1: caçar 1 arquivo de export real + a marca do monitor.
2. Fase 0 — Ação 2: achar 1 agrônomo consultor disposto a conversar/validar.
3. Só então: Fase 1 (protótipo geométrico).

---
*Documento vivo — v2, revisado pelo tribunal em 2026-06-23. Orçamento: R$ 0.*
