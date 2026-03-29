-- ============================================================
-- PLATAFORMA ENFERMERÍA DOMICILIARIA — Reina Elizabeth IPS
-- Schema PostgreSQL completo v1.0
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================
CREATE TYPE rol_usuario AS ENUM ('paciente', 'profesional', 'admin');
CREATE TYPE estado_usuario AS ENUM ('activo', 'suspendido', 'pendiente_verificacion');
CREATE TYPE estado_verificacion AS ENUM ('pendiente', 'aprobado', 'rechazado', 'vencido');
CREATE TYPE tipo_servicio AS ENUM ('rutina', 'urgente', 'emergencia');
CREATE TYPE estado_servicio AS ENUM ('pendiente', 'asignado', 'en_camino', 'en_curso', 'completado', 'cancelado');
CREATE TYPE metodo_pago AS ENUM ('tarjeta', 'pse', 'efectivo', 'plan_mensual');
CREATE TYPE estado_pago AS ENUM ('pendiente', 'aprobado', 'fallido', 'reembolsado');

-- ============================================================
-- DOMINIO: USUARIOS Y ACCESO
-- ============================================================
CREATE TABLE usuarios (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rol             rol_usuario NOT NULL,
    nombre_completo VARCHAR(200) NOT NULL,
    telefono        VARCHAR(20) UNIQUE NOT NULL,
    email           VARCHAR(150) UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    estado          estado_usuario NOT NULL DEFAULT 'activo',
    foto_url        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sesiones (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    usuario_id      UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL,
    refresh_hash    TEXT NOT NULL,
    dispositivo     VARCHAR(200),
    ip              INET,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE otp_codigos (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    telefono        VARCHAR(20) NOT NULL,
    codigo_hash     TEXT NOT NULL,
    intentos        INT NOT NULL DEFAULT 0,
    usado           BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DOMINIO: PACIENTES
-- ============================================================
CREATE TABLE pacientes (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    usuario_id          UUID NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
    documento_tipo      VARCHAR(10) NOT NULL DEFAULT 'CC',
    documento_numero    VARCHAR(20) NOT NULL UNIQUE,
    fecha_nacimiento    DATE NOT NULL,
    tipo_sangre         VARCHAR(5),
    eps                 VARCHAR(100),
    regimen             VARCHAR(50),
    direccion_base      TEXT,
    lat_base            DECIMAL(10,7),
    lng_base            DECIMAL(10,7),
    contacto_emergencia JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE historia_clinica (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    paciente_id             UUID NOT NULL UNIQUE REFERENCES pacientes(id) ON DELETE CASCADE,
    antecedentes_personales JSONB NOT NULL DEFAULT '{}',
    antecedentes_familiares JSONB NOT NULL DEFAULT '{}',
    alergias                TEXT[] NOT NULL DEFAULT '{}',
    diagnosticos_activos    JSONB NOT NULL DEFAULT '[]',
    medicacion_cronica      JSONB NOT NULL DEFAULT '[]',
    cirugia_previa          JSONB NOT NULL DEFAULT '[]',
    habitos                 JSONB NOT NULL DEFAULT '{}',
    notas_adicionales       TEXT,
    actualizado_por         UUID REFERENCES usuarios(id),
    actualizado_en          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DOMINIO: PROFESIONALES
-- ============================================================
CREATE TABLE profesionales (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    usuario_id              UUID NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
    documento_tipo          VARCHAR(10) NOT NULL DEFAULT 'CC',
    documento_numero        VARCHAR(20) NOT NULL UNIQUE,
    registro_rethus         VARCHAR(50) UNIQUE,
    titulo                  VARCHAR(200) NOT NULL,
    universidad             VARCHAR(200),
    año_graduacion          INT,
    especialidades          TEXT[] NOT NULL DEFAULT '{}',
    estado_verificacion     estado_verificacion NOT NULL DEFAULT 'pendiente',
    verificado_por          UUID REFERENCES usuarios(id),
    verificado_en           TIMESTAMPTZ,
    calificacion_promedio   DECIMAL(3,2) NOT NULL DEFAULT 0.00,
    total_servicios         INT NOT NULL DEFAULT 0,
    disponible              BOOLEAN NOT NULL DEFAULT FALSE,
    radio_servicio_km       INT NOT NULL DEFAULT 10,
    tarifa_hora             DECIMAL(10,2),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE documentos_profesional (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    profesional_id  UUID NOT NULL REFERENCES profesionales(id) ON DELETE CASCADE,
    tipo            VARCHAR(50) NOT NULL,
    nombre          VARCHAR(200) NOT NULL,
    url_s3          TEXT NOT NULL,
    estado          VARCHAR(20) NOT NULL DEFAULT 'pendiente',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ubicacion_profesional (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    profesional_id  UUID NOT NULL UNIQUE REFERENCES profesionales(id) ON DELETE CASCADE,
    lat             DECIMAL(10,7) NOT NULL,
    lng             DECIMAL(10,7) NOT NULL,
    geom            GEOGRAPHY(POINT, 4326),
    en_servicio     BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger para mantener geom sincronizado
CREATE OR REPLACE FUNCTION sync_geom()
RETURNS TRIGGER AS $$
BEGIN
    NEW.geom = ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326)::geography;
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_geom
BEFORE INSERT OR UPDATE ON ubicacion_profesional
FOR EACH ROW EXECUTE FUNCTION sync_geom();

-- ============================================================
-- DOMINIO: SERVICIOS
-- ============================================================
CREATE TABLE servicios (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    paciente_id         UUID NOT NULL REFERENCES pacientes(id),
    profesional_id      UUID REFERENCES profesionales(id),
    tipo                tipo_servicio NOT NULL DEFAULT 'rutina',
    estado              estado_servicio NOT NULL DEFAULT 'pendiente',
    descripcion         TEXT NOT NULL,
    lat_destino         DECIMAL(10,7) NOT NULL,
    lng_destino         DECIMAL(10,7) NOT NULL,
    direccion_destino   TEXT NOT NULL,
    tarifa              DECIMAL(10,2),
    duracion_minutos    INT,
    protocolo_aplicado  VARCHAR(100),
    asignado_en         TIMESTAMPTZ,
    iniciado_en         TIMESTAMPTZ,
    finalizado_en       TIMESTAMPTZ,
    cancelado_en        TIMESTAMPTZ,
    motivo_cancelacion  TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE evoluciones (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    servicio_id         UUID NOT NULL REFERENCES servicios(id) ON DELETE CASCADE,
    paciente_id         UUID NOT NULL REFERENCES pacientes(id),
    profesional_id      UUID NOT NULL REFERENCES profesionales(id),
    signos_vitales      JSONB NOT NULL DEFAULT '{}',
    procedimientos      TEXT[] NOT NULL DEFAULT '{}',
    medicamentos_admin  JSONB NOT NULL DEFAULT '[]',
    observaciones       TEXT,
    alertas_generadas   JSONB NOT NULL DEFAULT '[]',
    reporte_url         TEXT,
    fecha_hora          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE calificaciones (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    servicio_id     UUID NOT NULL REFERENCES servicios(id) ON DELETE CASCADE,
    autor_id        UUID NOT NULL REFERENCES usuarios(id),
    destinatario_id UUID NOT NULL REFERENCES usuarios(id),
    puntuacion      INT NOT NULL CHECK (puntuacion BETWEEN 1 AND 5),
    comentario      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (servicio_id, autor_id)
);

CREATE TABLE tracking_historial (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    servicio_id     UUID NOT NULL REFERENCES servicios(id) ON DELETE CASCADE,
    profesional_id  UUID NOT NULL REFERENCES profesionales(id),
    lat             DECIMAL(10,7) NOT NULL,
    lng             DECIMAL(10,7) NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DOMINIO: PAGOS Y PLANES
-- ============================================================
CREATE TABLE pagos (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    servicio_id     UUID NOT NULL REFERENCES servicios(id),
    paciente_id     UUID NOT NULL REFERENCES pacientes(id),
    monto           DECIMAL(10,2) NOT NULL,
    metodo          metodo_pago NOT NULL,
    estado          estado_pago NOT NULL DEFAULT 'pendiente',
    ref_externa     VARCHAR(200),
    pasarela        VARCHAR(50),
    respuesta_raw   JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE planes_mensuales (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    paciente_id         UUID NOT NULL REFERENCES pacientes(id),
    nombre              VARCHAR(100) NOT NULL,
    precio_mensual      DECIMAL(10,2) NOT NULL,
    servicios_incluidos INT NOT NULL DEFAULT 4,
    servicios_usados    INT NOT NULL DEFAULT 0,
    activo              BOOLEAN NOT NULL DEFAULT TRUE,
    fecha_inicio        DATE NOT NULL,
    fecha_fin           DATE NOT NULL,
    renovacion_auto     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DOMINIO: NOTIFICACIONES Y ALERTAS
-- ============================================================
CREATE TABLE notificaciones (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    usuario_id  UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    tipo        VARCHAR(50) NOT NULL,
    titulo      VARCHAR(200) NOT NULL,
    cuerpo      TEXT NOT NULL,
    datos       JSONB NOT NULL DEFAULT '{}',
    leida       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- ÍNDICES DE RENDIMIENTO
-- ============================================================
CREATE INDEX idx_servicios_estado        ON servicios(estado);
CREATE INDEX idx_servicios_paciente      ON servicios(paciente_id);
CREATE INDEX idx_servicios_profesional   ON servicios(profesional_id);
CREATE INDEX idx_servicios_created       ON servicios(created_at DESC);
CREATE INDEX idx_evoluciones_servicio    ON evoluciones(servicio_id);
CREATE INDEX idx_evoluciones_paciente    ON evoluciones(paciente_id);
CREATE INDEX idx_ubicacion_geom          ON ubicacion_profesional USING GIST(geom);
CREATE INDEX idx_tracking_servicio       ON tracking_historial(servicio_id, recorded_at DESC);
CREATE INDEX idx_notificaciones_usuario  ON notificaciones(usuario_id, leida, created_at DESC);
CREATE INDEX idx_sesiones_token          ON sesiones(token_hash);
CREATE INDEX idx_sesiones_expires        ON sesiones(expires_at);

-- ============================================================
-- FUNCIÓN: Motor de asignación por proximidad
-- ============================================================
CREATE OR REPLACE FUNCTION buscar_profesionales_cercanos(
    p_lat           DECIMAL,
    p_lng           DECIMAL,
    p_radio_km      INT DEFAULT 15,
    p_especialidad  TEXT DEFAULT NULL,
    p_limite        INT DEFAULT 10
)
RETURNS TABLE (
    profesional_id      UUID,
    usuario_id          UUID,
    nombre              VARCHAR,
    calificacion        DECIMAL,
    total_servicios     INT,
    distancia_km        DECIMAL,
    lat                 DECIMAL,
    lng                 DECIMAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        p.id,
        u.id,
        u.nombre_completo,
        p.calificacion_promedio,
        p.total_servicios,
        ROUND((ST_Distance(
            up.geom,
            ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
        ) / 1000)::DECIMAL, 2) AS distancia_km,
        up.lat,
        up.lng
    FROM profesionales p
    JOIN usuarios u ON u.id = p.usuario_id
    JOIN ubicacion_profesional up ON up.profesional_id = p.id
    WHERE
        p.estado_verificacion = 'aprobado'
        AND p.disponible = TRUE
        AND up.en_servicio = FALSE
        AND u.estado = 'activo'
        AND (p_especialidad IS NULL OR p_especialidad = ANY(p.especialidades))
        AND ST_DWithin(
            up.geom,
            ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
            p_radio_km * 1000
        )
    ORDER BY
        distancia_km ASC,
        p.calificacion_promedio DESC,
        p.total_servicios DESC
    LIMIT p_limite;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- TRIGGER: Actualizar calificación promedio del profesional
-- ============================================================
CREATE OR REPLACE FUNCTION actualizar_calificacion_profesional()
RETURNS TRIGGER AS $$
DECLARE v_prof_id UUID;
BEGIN
    SELECT s.profesional_id INTO v_prof_id
    FROM servicios s WHERE s.id = NEW.servicio_id;

    UPDATE profesionales SET
        calificacion_promedio = (
            SELECT ROUND(AVG(c.puntuacion)::DECIMAL, 2)
            FROM calificaciones c
            JOIN servicios s ON s.id = c.servicio_id
            WHERE s.profesional_id = v_prof_id
              AND c.autor_id != v_prof_id
        ),
        total_servicios = (
            SELECT COUNT(*) FROM servicios
            WHERE profesional_id = v_prof_id AND estado = 'completado'
        )
    WHERE id = v_prof_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_actualizar_calificacion
AFTER INSERT ON calificaciones
FOR EACH ROW EXECUTE FUNCTION actualizar_calificacion_profesional();

-- ============================================================
-- DATOS INICIALES
-- ============================================================
INSERT INTO usuarios (id, rol, nombre_completo, telefono, email, password_hash, estado)
VALUES (
    uuid_generate_v4(), 'admin', 'Administrador IPS',
    '+573000000000', 'admin@reinaelizabeth.com',
    crypt('Admin2024!', gen_salt('bf')), 'activo'
);
