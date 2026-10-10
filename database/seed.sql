-- =====================================================================
-- ARENA DO MAGRÃO — dados iniciais (rodar depois do schema.sql)
--
-- [PREENCHER] Tudo o que está NULL ou 0 aqui ainda não foi confirmado com a
-- Arena: WhatsApp, endereço, mapa, Pix, preços e mensalidade. O site mostra um
-- marcador "[PREENCHER: ...]" no lugar enquanto o valor não for preenchido.
-- Depois do lançamento, tudo isso se edita no painel (aba Configurações).
-- =====================================================================

INSERT INTO arenas (id, nome, slug, instagram,
                    whatsapp, endereco, link_mapa, pix_chave,      -- [PREENCHER]
                    antecedencia_reserva_min, antecedencia_cancelamento_horas,
                    janela_reserva_dias, duracoes_permitidas, intervalo_grade_min,
                    mensalidade_padrao_centavos, max_reservas_futuras)
VALUES (1, 'Arena do Magrão', 'arena-do-magrao', 'arena_do_magrao',
        NULL, NULL, NULL, NULL,
        120,          -- reservar com pelo menos 2 horas de antecedência
        12,           -- cancelar ou remarcar até 12 horas antes
        30,           -- reservar até 30 dias à frente
        '{60,90,120}',
        30,           -- horários começam de 30 em 30 minutos
        0,            -- [PREENCHER] valor padrão da mensalidade
        3);           -- no máximo 3 reservas futuras pelo mesmo WhatsApp

-- funcionamento de exemplo (do pedido inicial): seg a sex 17h–23h, sáb e dom 8h–22h
-- [PREENCHER] confirmar os horários reais com a Arena
INSERT INTO funcionamento (arena_id, dia_semana, hora_inicio, hora_fim) VALUES
  (1, 1, '17:00', '23:00'),   -- segunda
  (1, 2, '17:00', '23:00'),   -- terça
  (1, 3, '17:00', '23:00'),   -- quarta
  (1, 4, '17:00', '23:00'),   -- quinta
  (1, 5, '17:00', '23:00'),   -- sexta
  (1, 6, '08:00', '22:00'),   -- sábado
  (1, 0, '08:00', '22:00');   -- domingo

-- faixas de preço: noite de semana e fim de semana são horário nobre.
-- [PREENCHER] valores por hora (0 = ainda não informado) e onde começa o nobre
INSERT INTO faixas_preco (arena_id, dia_semana, hora_inicio, hora_fim, preco_hora_centavos, nobre)
SELECT 1, d, '17:00'::time, '19:00'::time, 0, FALSE FROM generate_series(1, 5) AS d     -- semana, fim de tarde
UNION ALL
SELECT 1, d, '19:00', '23:00', 0, TRUE  FROM generate_series(1, 5) AS d     -- semana, noite
UNION ALL
SELECT 1, d, '08:00', '22:00', 0, TRUE  FROM unnest(ARRAY[6, 0]) AS d;      -- sábado e domingo

-- ajusta a sequência, já que inserimos o id na mão
SELECT setval('arenas_id_seq', (SELECT MAX(id) FROM arenas));

-- contas_admin: criar com "npm run criar-admin" (a senha precisa passar pelo bcrypt)
