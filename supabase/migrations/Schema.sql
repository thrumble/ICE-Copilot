

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: count_matching_ids(bigint[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.count_matching_ids(active_ids bigint[]) RETURNS integer
    LANGUAGE sql
    AS $$
  select count(*)::int
  from public.equipment
  where id = any(active_ids);
$$;


--
-- Name: mark_inactive_equipment(bigint[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_inactive_equipment(active_ids bigint[]) RETURNS void
    LANGUAGE sql
    AS $$
  update public.equipment
  set is_active = false
  where is_active is distinct from false
    and id <> all(active_ids);
$$;


--
-- Name: set_chat_session_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_chat_session_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: billing_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_status (
    code text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branches (
    id bigint NOT NULL,
    company_id bigint,
    description text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tool_usage jsonb,
    token_usage jsonb,
    CONSTRAINT chat_messages_content_check CHECK ((char_length(content) > 0)),
    CONSTRAINT chat_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])))
);


--
-- Name: chat_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    title text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chat_sessions_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200)))
);


--
-- Name: contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contracts (
    id bigint NOT NULL,
    agreement_number text,
    billing_header_id bigint,
    billing_type text,
    customer_id bigint,
    order_number text,
    is_aggregate boolean,
    start_date timestamp without time zone,
    expiry_date timestamp without time zone
);


--
-- Name: created_service_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.created_service_jobs (
    id bigint NOT NULL,
    job_id bigint,
    customer_id bigint NOT NULL,
    equipment_id bigint NOT NULL,
    job_type text,
    fault_description text,
    reported_by text,
    api_response jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE created_service_jobs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.created_service_jobs IS 'Stores service job creation API responses from Signature Software API.';


--
-- Name: COLUMN created_service_jobs.job_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.created_service_jobs.job_id IS 'Unique service job identifier returned by Signature Software API.';


--
-- Name: COLUMN created_service_jobs.customer_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.created_service_jobs.customer_id IS 'Customer identifier associated with the service job.';


--
-- Name: COLUMN created_service_jobs.equipment_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.created_service_jobs.equipment_id IS 'Equipment/machine identifier associated with the service job.';


--
-- Name: COLUMN created_service_jobs.job_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.created_service_jobs.job_type IS 'Type of job, e.g. Maintenance.';


--
-- Name: COLUMN created_service_jobs.fault_description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.created_service_jobs.fault_description IS 'Detailed description of reported fault or issue.';


--
-- Name: COLUMN created_service_jobs.reported_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.created_service_jobs.reported_by IS 'Name of person who reported the issue.';


--
-- Name: COLUMN created_service_jobs.api_response; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.created_service_jobs.api_response IS 'Full raw JSON response from Signature Software API endpoint POST /api/v1/service/job.';


--
-- Name: created_service_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.created_service_jobs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.created_service_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id bigint NOT NULL,
    code text,
    trading_name text,
    registered_name text,
    email text,
    phone text,
    contact_person jsonb,
    street_address jsonb,
    postal_address jsonb,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: equipment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment (
    id bigint NOT NULL,
    serial_number character varying,
    equipment_code character varying,
    sales_staff json,
    customer json,
    billing_status json,
    equipment_type json,
    equipment_model json,
    equipment_module json,
    model_group json,
    install_date timestamp without time zone,
    create_date timestamp without time zone NOT NULL,
    has_customer_warranty boolean,
    has_supplier_warranty boolean,
    is_tax_exempt boolean,
    is_gst_exempt boolean,
    is_trade_in boolean,
    is_loan_equipment boolean,
    has_mailer_select boolean,
    has_billing_select boolean,
    has_mif_report_select boolean,
    is_active boolean,
    sv_call_ack_option character varying,
    phone_std character varying,
    phone_no character varying,
    fax_no character varying,
    fax_std character varying,
    mobile character varying,
    street_address character varying,
    suburb character varying,
    state character varying,
    post_code character varying,
    equip_no bigint,
    supplier_id bigint,
    equipment_description text,
    trading_name character varying
);


--
-- Name: equipment_billing_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_billing_type (
    code text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: equipment_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_models (
    id bigint NOT NULL,
    description text,
    equipment_type jsonb,
    model_group jsonb,
    default_meters jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: equipment_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_types (
    id bigint NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: service_call_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_call_types (
    id bigint NOT NULL,
    code text,
    description text,
    is_active boolean DEFAULT true,
    is_default_call_type boolean DEFAULT false,
    is_return_to_fit_type boolean DEFAULT false,
    is_maintenance_type boolean DEFAULT false,
    should_alert_on_excessive_call boolean DEFAULT false,
    should_calculate_response_times boolean DEFAULT false,
    should_bill_call_out boolean DEFAULT false,
    should_ignore_auto_bill boolean DEFAULT false,
    labour_depletion_rate jsonb DEFAULT '{"rate": 0, "isEnabled": false}'::jsonb,
    travel_depletion_rate jsonb DEFAULT '{"rate": 0, "isEnabled": false}'::jsonb,
    callout_depletion_rate jsonb DEFAULT '{"rate": 0, "isEnabled": false}'::jsonb,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: service_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_jobs (
    id bigint NOT NULL,
    company_id bigint,
    branch jsonb,
    customer jsonb,
    module jsonb,
    job_type text,
    summary text,
    service_job_status jsonb,
    service_call_type jsonb,
    billing_status jsonb,
    received_date timestamp with time zone,
    completed_date timestamp with time zone,
    down_time text,
    response_time text,
    expected_time text,
    service_job_calls jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: staff_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_members (
    id bigint NOT NULL,
    first_name text NOT NULL,
    surname text NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: billing_status billing_status_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_status
    ADD CONSTRAINT billing_status_code_key UNIQUE (code);


--
-- Name: branches branches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: chat_sessions chat_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_pkey PRIMARY KEY (id);


--
-- Name: contracts contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_pkey PRIMARY KEY (id);


--
-- Name: created_service_jobs created_service_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.created_service_jobs
    ADD CONSTRAINT created_service_jobs_pkey PRIMARY KEY (id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: equipment_billing_type equipment_billing_type_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_billing_type
    ADD CONSTRAINT equipment_billing_type_code_key UNIQUE (code);


--
-- Name: equipment_models equipment_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_models
    ADD CONSTRAINT equipment_models_pkey PRIMARY KEY (id);


--
-- Name: equipment equipment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment
    ADD CONSTRAINT equipment_pkey PRIMARY KEY (id);


--
-- Name: equipment_types equipment_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_types
    ADD CONSTRAINT equipment_types_pkey PRIMARY KEY (id);


--
-- Name: service_call_types service_call_types_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_call_types
    ADD CONSTRAINT service_call_types_code_key UNIQUE (code);


--
-- Name: service_call_types service_call_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_call_types
    ADD CONSTRAINT service_call_types_pkey PRIMARY KEY (id);


--
-- Name: service_jobs service_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_jobs
    ADD CONSTRAINT service_jobs_pkey PRIMARY KEY (id);


--
-- Name: staff_members staff_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_members
    ADD CONSTRAINT staff_members_pkey PRIMARY KEY (id);


--
-- Name: chat_messages_session_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_session_created_idx ON public.chat_messages USING btree (session_id, created_at);


--
-- Name: chat_sessions_user_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_sessions_user_updated_idx ON public.chat_sessions USING btree (user_id, updated_at DESC);


--
-- Name: idx_created_service_jobs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_created_service_jobs_created_at ON public.created_service_jobs USING btree (created_at DESC);


--
-- Name: idx_created_service_jobs_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_created_service_jobs_customer_id ON public.created_service_jobs USING btree (customer_id);


--
-- Name: idx_created_service_jobs_equipment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_created_service_jobs_equipment_id ON public.created_service_jobs USING btree (equipment_id);


--
-- Name: idx_created_service_jobs_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_created_service_jobs_job_id ON public.created_service_jobs USING btree (job_id);


--
-- Name: chat_sessions chat_sessions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER chat_sessions_updated_at BEFORE UPDATE ON public.chat_sessions FOR EACH ROW EXECUTE FUNCTION public.set_chat_session_updated_at();


--
-- Name: chat_messages chat_messages_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.chat_sessions(id) ON DELETE CASCADE;


--
-- Name: chat_sessions chat_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_sessions
    ADD CONSTRAINT chat_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: created_service_jobs Allow service role full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow service role full access" ON public.created_service_jobs TO service_role USING (true) WITH CHECK (true);


--
-- Name: chat_messages Users add messages to their sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users add messages to their sessions" ON public.chat_messages FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.chat_sessions s
  WHERE ((s.id = chat_messages.session_id) AND (s.user_id = auth.uid())))));


--
-- Name: chat_messages Users delete messages from their sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users delete messages from their sessions" ON public.chat_messages FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.chat_sessions s
  WHERE ((s.id = chat_messages.session_id) AND (s.user_id = auth.uid())))));


--
-- Name: chat_sessions Users manage their own chat sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage their own chat sessions" ON public.chat_sessions TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: chat_messages Users read messages from their sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users read messages from their sessions" ON public.chat_messages FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.chat_sessions s
  WHERE ((s.id = chat_messages.session_id) AND (s.user_id = auth.uid())))));


--
-- Name: billing_status; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_status ENABLE ROW LEVEL SECURITY;

--
-- Name: branches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: contracts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;

--
-- Name: created_service_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.created_service_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

--
-- Name: equipment; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.equipment ENABLE ROW LEVEL SECURITY;

--
-- Name: equipment_billing_type; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.equipment_billing_type ENABLE ROW LEVEL SECURITY;

--
-- Name: equipment_models; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.equipment_models ENABLE ROW LEVEL SECURITY;

--
-- Name: equipment_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.equipment_types ENABLE ROW LEVEL SECURITY;

--
-- Name: service_call_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.service_call_types ENABLE ROW LEVEL SECURITY;

--
-- Name: service_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.service_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff_members ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--
