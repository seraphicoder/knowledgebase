// Sample email bodies for noise-filter unit tests. These represent message
// bodies as produced by the IMAP connector (already extracted from MIME).

export const WITH_SIGNATURE = `Hi team,

To reset the admin password, go to Settings > Security > Reset Password and
follow the email link. The link expires in 30 minutes.

Best regards,
Jane Doe
Senior Support Engineer
Acme Corp | +1 555 0100
jane@acme.example`;

export const WITH_DISCLAIMER = `The fix is to clear the cache in Preferences > Advanced.

CONFIDENTIALITY NOTICE: This email and any attachments are confidential and
may be legally privileged. If you are not the intended recipient, please delete
it and notify the sender immediately.`;

export const WITH_QUOTED_REPLY = `Yes, restarting the service resolves it. Run "systemctl restart acme".

On Tue, Jan 7, 2026 at 9:14 AM, Bob <bob@customer.example> wrote:
> The service keeps crashing after the upgrade. What should I do?
> Thanks,
> Bob`;

export const OOO_REPLY = `Automatic reply: I am out of office until Monday with no access to email.
For urgent issues contact support@acme.example.`;

export const DASH_SIGNATURE = `You can export your data from the Reports tab using the CSV button.

--
Carlos Ruiz
Customer Success`;

export const CLEAN_NO_NOISE = `Question: how do I enable two-factor authentication?
Answer: Open your profile, choose Security, then toggle Two-Factor Auth and scan the QR code.`;
