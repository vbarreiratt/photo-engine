-- Migration: create_batches_table
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,
    prompt TEXT,
    model TEXT,
    status TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Habilitar Row Level Security (RLS)
ALTER TABLE public.batches ENABLE ROW LEVEL SECURITY;

-- Usuários só podem ver e inserir seus próprios lotes (batches)
CREATE POLICY "Users can view their own batches"
    ON public.batches FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own batches"
    ON public.batches FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own batches"
    ON public.batches FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own batches"
    ON public.batches FOR DELETE
    USING (auth.uid() = user_id);
