-- 008: the MCP server's full-text index of the billing guide (schema `docs`), separate
-- from the billing data. Built once from documents/*.md and rebuilt only when its parsed
-- sections change, never per question (assignment line 11).
CREATE SCHEMA docs;

CREATE TABLE docs.documents (
    id          BIGSERIAL    CONSTRAINT pk_documents PRIMARY KEY,
    document_id VARCHAR(40)  NOT NULL CONSTRAINT uq_documents_document_id UNIQUE, -- "MOB-BILLING-2026-01"
    file_name   VARCHAR(200) NOT NULL,                                            -- "Mobile_Provider_Billing_Guide.md"
    title       VARCHAR(200) NOT NULL,
    version     VARCHAR(20)  NOT NULL,
    source_hash CHAR(64)     NOT NULL,  -- SHA-256 of the parsed sections: unchanged = no rebuild
    indexed_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- One chunk per numbered section (§9 of the guide: answers cite "section ID, heading,
-- document ID, and text").
CREATE TABLE docs.chunks (
    id            BIGSERIAL    CONSTRAINT pk_chunks PRIMARY KEY,
    document_id   BIGINT       NOT NULL
        CONSTRAINT fk_chunks_document_id_documents REFERENCES docs.documents (id) ON DELETE CASCADE,
    ordinal       INTEGER      NOT NULL,  -- order in the document
    section       VARCHAR(10)  NOT NULL,  -- "3.2"
    heading       VARCHAR(200) NOT NULL,  -- "Additional internet blocks"
    text          TEXT         NOT NULL,
    -- Computed by the database (English stemming: "blocks" matches "block"); a match in the
    -- heading (weight A) ranks above one in the body (weight B).
    search_vector TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('english', heading), 'A') || setweight(to_tsvector('english', text), 'B')
    ) STORED,
    CONSTRAINT uq_chunks_document_id_section UNIQUE (document_id, section),
    CONSTRAINT uq_chunks_document_id_ordinal UNIQUE (document_id, ordinal)
);

CREATE INDEX ix_chunks_search_vector ON docs.chunks USING GIN (search_vector);
